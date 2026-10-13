#!/usr/bin/env bash
#
# Read-only health check for the Firestore data-protection set up by
# enable-firestore-backups.sh on the olio-wallet (default) database. Confirms:
#   1. Point-in-time recovery (PITR) is still ENABLED.
#   2. A daily managed backup schedule exists.
#   3. A weekly managed backup schedule exists.
#   4. At least one backup has actually been produced, and the most recent one
#      is FRESH (younger than MAX_BACKUP_AGE_HOURS) — a scheduled daily backup
#      should never be older than ~a day.
#
# Exits 0 only if every check passes; non-zero otherwise. Designed to run as a
# manual spot-check, a cron healthcheck, or a CI step. It NEVER creates, deletes,
# or mutates anything — only `describe`/`list`.
#
# WHY a separate verifier: a schedule can be silently deleted, PITR can get
# turned off, or backups can quietly stop being produced (a quota, permission,
# or location change) with NO alert — and you'd only find out the moment you
# needed a restore. This turns "are we still protected?" into one command.
#
# Required: gcloud CLI authenticated as a principal with Firestore read access on
# olio-wallet (the same auth enable-firestore-backups.sh needs). Firebase-CLI
# equivalents for the underlying reads are in infra/README.md.
#
#   bash infra/verify-firestore-backups.sh
#
set -uo pipefail

PROJECT_ID="olio-wallet"
DATABASE="(default)"
LOCATION="eur3"            # the (default) DB lives in the EU multi-region
MAX_BACKUP_AGE_HOURS=26    # a daily backup should never be older than this

fail=0
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=1; }

# RFC3339 (e.g. 2026-06-18T05:27:12.357117Z) -> epoch seconds, portable across
# GNU date (Linux/CI) and BSD date (macOS).
to_epoch() {
  local ts="${1%Z}"   # strip trailing Z
  ts="${ts%.*}"       # strip fractional seconds, if any
  if date -u -d "${ts}Z" +%s >/dev/null 2>&1; then
    date -u -d "${ts}Z" +%s
  else
    date -u -j -f "%Y-%m-%dT%H:%M:%S" "$ts" +%s 2>/dev/null
  fi
}

echo "Firestore backup verification — ${PROJECT_ID} / ${DATABASE} (${LOCATION})"
echo "  account: $(gcloud config get-value account 2>/dev/null || echo '?')"
echo

# 1. Point-in-time recovery
echo "== 1/4: Point-in-time recovery =="
pitr=$(gcloud firestore databases describe --database="${DATABASE}" --project="${PROJECT_ID}" \
  --format='value(pointInTimeRecoveryEnablement)' 2>/dev/null || true)
if [ "${pitr}" = "POINT_IN_TIME_RECOVERY_ENABLED" ]; then
  ok "PITR enabled (continuous 7-day recovery window)"
else
  bad "PITR is NOT enabled (got: '${pitr:-<none / query failed>}')"
fi
echo

# 2 + 3. Backup schedules. The recurrence type is encoded by the presence of a
# `dailyRecurrence` / `weeklyRecurrence` field, not a scalar value — so grep the
# JSON for those keys (robust without a JSON parser).
echo "== 2/4 + 3/4: Backup schedules =="
sched_json=$(gcloud firestore backups schedules list --database="${DATABASE}" --project="${PROJECT_ID}" \
  --format=json 2>/dev/null || true)
if printf '%s' "${sched_json}" | grep -q '"dailyRecurrence"'; then
  ok "daily schedule present"
else
  bad "daily backup schedule MISSING"
fi
if printf '%s' "${sched_json}" | grep -q '"weeklyRecurrence"'; then
  ok "weekly schedule present"
else
  bad "weekly backup schedule MISSING"
fi
echo

# 4. A real, fresh backup exists.
echo "== 4/4: Recent backup exists =="
latest=$(gcloud firestore backups list --location="${LOCATION}" --project="${PROJECT_ID}" \
  --format='value(snapshotTime)' --sort-by='~snapshotTime' 2>/dev/null | head -1 || true)
if [ -z "${latest}" ]; then
  bad "no backups found in ${LOCATION} — none have been produced yet, or the location is wrong"
else
  latest_epoch=$(to_epoch "${latest}")
  now_epoch=$(date -u +%s)
  if [ -z "${latest_epoch}" ]; then
    bad "found a backup (${latest}) but could not parse its timestamp to check freshness"
  else
    age_h=$(( (now_epoch - latest_epoch) / 3600 ))
    if [ "${age_h}" -le "${MAX_BACKUP_AGE_HOURS}" ]; then
      ok "most recent backup is ${age_h}h old (${latest}) — within ${MAX_BACKUP_AGE_HOURS}h"
    else
      bad "most recent backup is ${age_h}h old (${latest}) — STALE (> ${MAX_BACKUP_AGE_HOURS}h); the daily schedule may have stopped"
    fi
  fi
fi
echo

if [ "${fail}" -eq 0 ]; then
  echo "Result: ✓ all Firestore backup protections are live."
  exit 0
else
  echo "Result: ✗ one or more checks FAILED — investigate before relying on a restore."
  echo "  Re-apply with: bash infra/enable-firestore-backups.sh"
  echo "  Restore runbook: infra/README.md → 'Disaster recovery (Firestore data)'"
  exit 1
fi
