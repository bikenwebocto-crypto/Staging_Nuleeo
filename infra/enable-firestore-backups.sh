#!/usr/bin/env bash
#
# Enables Firestore data-protection for the olio-wallet (default) database:
#   1. Point-in-time recovery (PITR) — continuous 7-day recovery window.
#   2. A daily managed backup schedule  — 7-day retention.
#   3. A weekly managed backup schedule — 14-week retention (Sundays).
#
# WHY: until this is applied, the production store of leases, rent ledgers,
# tenant PII and IBANs has NO recovery path. The GCS soft-delete window in
# bucket-lifecycle.json only protects Cloud Storage *files* (avatars, photos,
# uploaded docs) — it does nothing for Firestore *data*. A bad migration, an
# erroneous cascade-delete, or an accidental collection wipe would be
# unrecoverable. PITR covers "undo the last few days at minute granularity";
# the daily/weekly managed backups cover longer-horizon and full-database
# loss. Restore procedures are in README.md → "Disaster recovery (Firestore)".
#
# Managed backups are stored by Firestore itself (no GCS bucket required) and
# live in the database's own location.
#
# Idempotent-ish: re-running --enable-pitr is a no-op if PITR is already on.
# Firestore allows at most ONE daily + ONE weekly schedule per database, so
# re-creating an existing schedule errors — that error is caught and ignored
# below. To change a retention period, delete the schedule and re-run, or use
# `gcloud firestore backups schedules update`.
#
# Required: gcloud CLI authenticated as an owner/editor of olio-wallet with the
# Firestore API enabled. Flag names/limits are GA but vary slightly by gcloud
# version — if a command is rejected, check `gcloud firestore backups schedules
# create --help`. Run once; re-run only to change configuration. (Applied to
# olio-wallet on 2026-06-17 via the Firebase CLI — gcloud isn't installed on the
# maintainer's machine; the firebase-tools equivalents are in infra/README.md.)

set -euo pipefail

PROJECT_ID="olio-wallet"
DATABASE="(default)"

echo "Firestore data-protection setup for ${PROJECT_ID} / ${DATABASE}"
echo

echo "== 1/3: Enable point-in-time recovery (7-day window) =="
gcloud firestore databases update \
  --project="${PROJECT_ID}" \
  --database="${DATABASE}" \
  --enable-pitr

echo
echo "== 2/3: Daily managed backup schedule (7-day retention) =="
gcloud firestore backups schedules create \
  --project="${PROJECT_ID}" \
  --database="${DATABASE}" \
  --recurrence=daily \
  --retention=7d || echo "(daily schedule already exists — safe to ignore)"

echo
echo "== 3/3: Weekly managed backup schedule (14-week retention, Sundays) =="
gcloud firestore backups schedules create \
  --project="${PROJECT_ID}" \
  --database="${DATABASE}" \
  --recurrence=weekly \
  --day-of-week=SUNDAY \
  --retention=14w || echo "(weekly schedule already exists — safe to ignore)"

echo
echo "Done. Verify with:"
echo "  gcloud firestore databases describe --database='${DATABASE}' --project=${PROJECT_ID} \\"
echo "    --format='value(pointInTimeRecoveryEnablement)'   # expect: POINT_IN_TIME_RECOVERY_ENABLED"
echo "  gcloud firestore backups schedules list --database='${DATABASE}' --project=${PROJECT_ID}"
echo "  gcloud firestore backups list --location=eur3 --project=${PROJECT_ID}   # after first backup (DB is in eur3)"
