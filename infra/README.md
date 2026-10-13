# Olio infra config

Files in this directory are GCP/Firebase configuration that lives **outside**
the Cloud Functions runtime and must be applied with `gcloud`, `gsutil`, or
Terraform-style tooling. Every file is checked into git so the production
config is auditable + reproducible, but applying any of these requires
authenticated CLI access to the `olio-wallet` project.

The CI/CD pipeline does **not** apply these automatically — they're rarely
edited and applying them on every deploy would be wasteful + risky. Apply
once when introducing each item, then on intentional changes.

## Files

- `bucket-lifecycle.json` — Cloud Storage lifecycle rules for the Olio
  bucket. Only configures the soft-delete recovery window (7 days
  retention after a delete() call). **Intentionally does NOT include
  age-based prefix-delete rules** — a "delete avatars older than 1 year"
  rule would silently nuke active users' avatars after a redeploy gap,
  leaving `User.photoURL` 404ing platform-wide. Orphan cleanup is the
  job of the per-property + per-user cascade-delete code in
  `server/routes.ts:4214` and `server/services/userDelete.ts`, not a
  blind lifecycle sweep.
- `deletion-protection-lien.sh` — One-shot script to register a GCP
  resource lien that blocks `gcloud projects delete olio-wallet`. Prevents
  the worst-case "co-owner clicks Delete in the Firebase console" mistake.
- `monitoring-stripe-connect-disabled.yaml` — Cloud Monitoring alert policy
  that pages on our platform Connect account flipping `chargesEnabled:
false`. Without this we'd find out from the first tenant whose rent
  payment 503s instead of from a proactive alert.
- `enable-firestore-backups.sh` — Enables Firestore point-in-time recovery
  (7-day window) plus daily (7-day) and weekly (14-week) managed backup
  schedules. Until applied, Firestore **data** (leases, rent ledgers, IBANs,
  tenant PII) has **no recovery path** — `bucket-lifecycle.json`'s soft-delete
  only protects Cloud Storage **files**, never Firestore documents. Restore
  procedures are under "Disaster recovery (Firestore data)" below.
- `monitoring-api-error-rate.yaml` — Cloud Monitoring alert policy that pages
  when the `api` function logs server errors above a sustained rate (unhandled
  500s, failed Stripe webhook handlers, any `logError`). Backed by a log-based
  metric the file documents.
- `monitoring-client-errors.yaml` — Cloud Monitoring alert policy that pages on
  a spike of browser crashes the SPAs report to `POST /api/client-errors`
  (logged as `client.error`). Catches a bad frontend deploy white-screening
  users. There is also a continuous **uptime check** on `/api/health/firebase`
  (no file — created in the Console / via gcloud; see "How to apply").

## How to apply each

### Bucket lifecycle

```bash
gsutil lifecycle set infra/bucket-lifecycle.json \
  gs://olio-wallet.firebasestorage.app
```

Verify:

```bash
gsutil lifecycle get gs://olio-wallet.firebasestorage.app
```

### Deletion-protection lien

```bash
bash infra/deletion-protection-lien.sh
```

The script prints the lien id; record it in your operations runbook.
Remove with `gcloud resource-manager liens delete <id>` if you ever
intentionally tear down the project.

### Stripe Connect disabled alert

Requires a notification channel (email/Slack/PagerDuty) created in Cloud
Monitoring first. Capture its full resource name, then:

```bash
gcloud alpha monitoring policies create \
  --policy-from-file=infra/monitoring-stripe-connect-disabled.yaml \
  --project=olio-wallet
```

The policy depends on a custom log-based metric `stripe_connect_charges_disabled`
which the policy file documents how to create.

### Error-rate & client-error alerts

Each YAML documents its prerequisite log-based metric at the top. Create the
metric, then the policy (and wire a notification channel as above):

```bash
# 1. Create the log-based metrics (see the comment block in each YAML for the
#    exact --log-filter):
gcloud logging metrics create api_error_logs --project=olio-wallet --log-filter='…'
gcloud logging metrics create client_errors  --project=olio-wallet --log-filter='…'

# 2. Create the alert policies from the YAML:
gcloud alpha monitoring policies create \
  --policy-from-file=infra/monitoring-api-error-rate.yaml --project=olio-wallet
gcloud alpha monitoring policies create \
  --policy-from-file=infra/monitoring-client-errors.yaml --project=olio-wallet
```

`client.error` logs come from the SPAs via `POST /api/client-errors`. The
server-side error-rate metric covers unhandled 500s as well as the
`stripe.webhook-handler-failed` and `stripe.webhook-signature-failed` events.

### Uptime check on the liveness probe

Nothing watches `GET /api/health/firebase` between deploys. Add a continuous
uptime check (easiest in the **Cloud Console → Monitoring → Uptime checks →
Create**: HTTPS, host `app.oliowallet.com`, path `/api/health/firebase`, every
1 min, then attach a notification channel). Or via gcloud (confirm flags for
your CLI version with `gcloud monitoring uptime create --help`):

```bash
gcloud monitoring uptime create "Olio api liveness" \
  --resource-type=uptime-url \
  --resource-labels=host=app.oliowallet.com,project_id=olio-wallet \
  --path="/api/health/firebase" --period=1 --timeout=10 \
  --project=olio-wallet
```

### Billing budget & cost alert

GCP has no spend tripwire by default — a traffic spike or abuse flood (the rate
limiters are per-action, not global) turns straight into an uncapped bill. Set a
Cloud Billing budget on the billing account that funds `olio-wallet`.

Easiest in the **Cloud Console → Billing → Budgets & alerts → Create budget**:
scope it to the `olio-wallet` project, set a monthly amount (start around 2× your
typical bill and tune), and add threshold alerts at 50% / 90% / 100% that email
the billing admins. Or via gcloud (confirm flags with
`gcloud billing budgets create --help`):

```bash
gcloud billing budgets create \
  --billing-account=BILLING_ACCOUNT_ID \
  --display-name="Olio monthly budget" \
  --budget-amount=100EUR \
  --filter-projects=projects/olio-wallet \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0
```

The `api` function's `maxInstances: 20` (functions/src/index.ts) already bounds
the worst case; the budget is the backstop that actually tells a human. For
richer routing (Slack/PagerDuty), point the budget at a Pub/Sub topic and fan
out. The incident playbook for a cost spike is in `SECURITY.md` → "Tier 5".

### Firestore backups & PITR

```bash
bash infra/enable-firestore-backups.sh
```

One-shot. Enables point-in-time recovery and creates the daily + weekly managed
backup schedules, then prints the verify commands. Re-run only to change
configuration. See "Disaster recovery (Firestore data)" below for how to
actually restore.

**Status: APPLIED 2026-06-17.** PITR is enabled (7-day window), with daily
(7-day) and weekly (98-day) managed backup schedules live on the `(default)`
database. It was applied via the **Firebase CLI** (gcloud isn't installed on the
maintainer's machine); the `firebase-tools` equivalents of the script are:

```bash
firebase firestore:databases:update "(default)" --point-in-time-recovery ENABLED --project olio-wallet
firebase firestore:backups:schedules:create --database "(default)" --recurrence DAILY  --retention 7d  --project olio-wallet
firebase firestore:backups:schedules:create --database "(default)" --recurrence WEEKLY --day-of-week SUNDAY --retention 98d --project olio-wallet
# verify:
firebase firestore:databases:get "(default)" --project olio-wallet
firebase firestore:backups:schedules:list --database "(default)" --project olio-wallet
```

## Disaster recovery (Firestore data)

`enable-firestore-backups.sh` provides three recovery mechanisms. The commands
below use gcloud; the Firebase CLI equivalents above also work. The database is
in the `eur3` European multi-region (confirm with `firebase
firestore:databases:get '(default)' --project olio-wallet`).

**Important:** Firestore restores are NOT in-place. A managed-backup restore
always creates a _new_ database; PITR recovery is done by exporting a past
snapshot and re-importing. Decide first whether you're undoing a recent partial
mistake (PITR) or recovering from full/older loss (managed backup).

### 1. PITR — undo the last ≤7 days (minute granularity)

Best for "a migration corrupted/deleted data N hours ago". Export the database
as it existed at a past timestamp into a GCS bucket, then import it back.

```bash
# Pick a timestamp BEFORE the incident (RFC3339, within the last 7 days):
SNAP="2026-06-17T13:00:00Z"
BUCKET="gs://olio-wallet-firestore-recovery"   # create once: gsutil mb -l EU "$BUCKET"  (EU multi-region, matches the Firestore location)

# Export the pre-incident snapshot:
gcloud firestore export "$BUCKET/pitr-$SNAP" \
  --snapshot-time="$SNAP" --project=olio-wallet

# Inspect if needed, then import back into the live database:
gcloud firestore import "$BUCKET/pitr-$SNAP" --project=olio-wallet
```

A full import overwrites documents present in the export. To recover only one
collection, add `--collection-ids=COLLECTION` to both export and import.

### 2. Managed backup — recover from full or older loss (≤14 weeks)

```bash
# List available backups (use the database's location):
gcloud firestore backups list --location=eur3 --project=olio-wallet

# Restore a chosen backup into a NEW database (cannot restore over (default)):
gcloud firestore databases restore \
  --source-backup=projects/olio-wallet/locations/eur3/backups/BACKUP_ID \
  --destination-database=restored-YYYYMMDD --project=olio-wallet
```

Then inspect `restored-YYYYMMDD`. The Admin SDK (server/firebase.ts) talks to
the `(default)` database, so to put data back the simplest path is to export
from the restored DB and import into `(default)` (as in step 1), rather than
re-pointing the app.

### 3. Verify the protection is live

One read-only command — checks PITR is on, both (daily + weekly) schedules
exist, and a fresh backup was actually produced (< 26h old). Exits non-zero if
anything is wrong, so it doubles as a cron / CI healthcheck:

```bash
bash infra/verify-firestore-backups.sh
```

Or the underlying reads by hand:

```bash
gcloud firestore databases describe --database='(default)' --project=olio-wallet \
  --format='value(pointInTimeRecoveryEnablement)'        # POINT_IN_TIME_RECOVERY_ENABLED
gcloud firestore backups schedules list --database='(default)' --project=olio-wallet
gcloud firestore backups list --location=eur3 --project=olio-wallet  # most recent snapshotTime
```

### 4. GCP project suspended (CONSUMER_SUSPENDED)

**Symptoms:** every Hosting site (oliowallet.com, app.oliowallet.com,
platform.oliowallet.com) returns Firebase's "Site Not Found" 404
simultaneously, and every Google API call — including CI's Workload Identity
Federation token exchange and the backup-check workflow — fails with
`Permission denied: Consumer 'projects/olio-wallet' has been suspended`
(reason `CONSUMER_SUSPENDED`).

**Instant no-auth diagnosis:**

```bash
curl -s "https://firestore.googleapis.com/v1/projects/olio-wallet/databases/(default)/documents/probe/probe"
```

A healthy project returns a plain 403 `PERMISSION_DENIED` (rules deny
anonymous reads). A suspended one says `CONSUMER_SUSPENDED` in the error
body — no credentials needed to tell the two apart.

**Root cause is often NOT billing.** In the 2026-07-14 incident billing was
fully paid; the cause was the project's sole OWNER Google account
(`oliowallet@gmail.com`) being disabled by Google — GCP auto-suspends
projects owned by a disabled account. The owner's local `gcloud` refresh
token also dies (`invalid_grant`) when this happens.

**Restore path:** appeal the _account_, not the project. The disabled-account
sign-in flow at accounts.google.com offers an appeal; the approval email goes
to the appeal contact. After "Appeal approved," sign in as the account and
complete verification — the project suspension then lifts on its own
(minutes to hours). If the project stays suspended after the account is
restored, use the suspension banner in console.cloud.google.com or open a GCP
support case.

**While suspended:**

- Firestore data is intact but frozen (backups/PITR can't be read either).
- All in-project Cloud Monitoring alerts are dead — only the external
  `.github/workflows/uptime-check.yml` watchdog (runs outside Google) detects
  the outage.
- Scheduled Functions (rent reminders, indexation, lease expiry) do not run.
- Stripe keeps retrying failed webhook deliveries per-event for ~72h —
  restore within that window and events self-heal; beyond it, resend dead
  events from the Stripe dashboard (Developers → Webhooks → the endpoint →
  failed deliveries).

**Aftermath checklist:**

- `gcloud auth login` the owner account again (disable revokes tokens).
- Confirm all three sites return 200 and `GET /api/health/firebase` returns
  `{"ok":true}`.
- `workflow_dispatch` the backup-check and uptime-check workflows.
- Check Stripe webhook deliveries and resend anything dead.
- Confirm the daily crons resumed.

**Prevention:** a single human OWNER is a single point of failure for the
whole company — keep at least two OWNER principals on the project. The
deletion-protection lien (`deletion-protection-lien.sh`) does NOT protect
against suspension.

## Rollback

The Deploy workflow ships hosting, functions, and rules atomically. If a deploy
goes out bad, roll each surface back independently — there's no single
"undo the whole deploy" button, so do the surface(s) that broke.

All commands need authenticated CLI access to `olio-wallet` (the same
`firebase-tools@^14` the workflow uses). Install once with
`npm install -g firebase-tools@^14`, then `firebase login`.

### Hosting (per site)

Firebase keeps the previous releases of each Hosting site, so a rollback is
instant (re-points the live channel at the prior release; no rebuild). Hosting
sites are **per-site**, so roll back only the one(s) that broke. The three
site IDs (from `.firebaserc`) are:

- `olio-wallet` → oliowallet.com (landing)
- `oliowallet-app` → app.oliowallet.com (app)
- `oliowallet-platform` → platform.oliowallet.com (platform)

```bash
# Roll the live release back one version on a single site:
firebase hosting:rollback --site olio-wallet --project olio-wallet
firebase hosting:rollback --site oliowallet-app --project olio-wallet
firebase hosting:rollback --site oliowallet-platform --project olio-wallet
```

To pick a specific older release instead of just "the previous one", list the
release history and clone an old one to live:

```bash
firebase hosting:releases:list --site oliowallet-app --project olio-wallet
# then in the Firebase console (Hosting → site → release history) use
# "Roll back" on the chosen release — the CLI rollback only steps back one.
```

Confirm the rollback served by curling the site and grepping the bundle, e.g.:

```bash
curl -s https://app.oliowallet.com/ -o /dev/null -w "%{http_code}\n"
```

### Functions

Cloud Functions don't have a one-shot CLI rollback — you redeploy the function
from a known-good commit. Re-run the Deploy workflow pinned to the previous
(good) SHA via `workflow_dispatch`:

```bash
# Replace <GOOD_SHA> with the last commit that deployed cleanly:
gh workflow run deploy.yml --ref <GOOD_SHA> --repo oliowallet/olio-fe
gh run watch --repo oliowallet/olio-fe
```

Because the workflow checks out `github.event.workflow_run.head_sha || github.sha`,
a `workflow_dispatch` on `--ref <GOOD_SHA>` builds + deploys exactly that
commit's functions (and re-runs the manual-deploy verification gate first, so a
broken SHA won't redeploy). This re-ships hosting + rules too, so if only
functions were bad it cleanly restores everything to that commit's state.

If you cannot wait for a workflow run, redeploy functions only from a local
checkout of the good commit:

```bash
git checkout <GOOD_SHA>
npm ci && npm run build
( cd functions && npm ci && npm run build )
firebase deploy --only functions --project olio-wallet --non-interactive
git checkout main   # don't leave the worktree detached
```

### Firestore / Storage rules

Rules are versioned in git (`firestore.rules`, `storage.rules`). To revert a bad
rules change, restore the prior file from git and redeploy just the rules — this
is fast and low-risk, and avoids a full functions/hosting redeploy:

```bash
# Restore the previous version of the rules files:
git checkout <GOOD_SHA> -- firestore.rules storage.rules
firebase deploy --only firestore,storage --project olio-wallet --non-interactive
# Then commit the revert so main matches what's live:
git add firestore.rules storage.rules
git commit -m "revert: roll back firestore/storage rules to <GOOD_SHA>"
```

Firestore also retains a rules release history in the console
(Firestore → Rules → release history) if you'd rather roll back there without a
git revert — but always reconcile git back to what's live afterward so the next
deploy doesn't silently re-ship the bad rules.
