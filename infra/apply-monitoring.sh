#!/usr/bin/env bash
#
# One-shot M8 setup: creates the 3 log-based metrics + 3 Cloud Monitoring alert
# policies and wires them to the email notification channel. Run ONCE in Cloud
# Shell as an owner/editor (the firebase-adminsdk SA lacks Monitoring perms).
#
# Self-contained on purpose (no repo checkout needed): paste it into the Cloud
# Shell EDITOR (not the terminal — long lines get chopped on terminal paste),
# save, then `bash apply-monitoring.sh`.
#
# Filters use resource.type="cloud_run_revision" + service_name="api" because the
# api function is 2nd-gen (verified 2026-06-21 — its logs surface on Cloud Run,
# NOT under cloud_function).
#
# Metric creation is safe to re-run (errors harmlessly if it already exists).
# Policy creation is NOT idempotent — re-running makes DUPLICATES, so run the
# policy section only once. To redo, delete the policies in the console first.

set -uo pipefail
P=olio-wallet
CH=projects/olio-wallet/notificationChannels/6264040661698284334

echo "== 1/2  log-based metrics =="
gcloud logging metrics create api_error_logs --project="$P" \
  --description="ERROR-severity logs from the Olio api function" \
  --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND severity>=ERROR' || true
gcloud logging metrics create client_errors --project="$P" \
  --description="Browser crashes reported by the Olio SPAs" \
  --log-filter='resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND jsonPayload.event="client.error"' || true
gcloud logging metrics create stripe_connect_charges_disabled --project="$P" \
  --description="Olio platform Connect account chargesEnabled went false" \
  --log-filter='resource.type="cloud_run_revision" AND severity>=WARNING AND jsonPayload.event="stripe.platform-disabled"' || true

echo "== 2/2  alert policies =="

cat > /tmp/m8-api.yaml <<EOF
displayName: "Olio api — server error rate elevated"
combiner: OR
enabled: true
documentation:
  content: |
    The api function is logging ERROR-severity entries above the normal rate.
    Likely a broken deploy, a downstream outage (Firestore/Stripe), or a bug
    throwing on a request path. First: Cloud Logging severity>=ERROR,
    resource.labels.service_name="api", last 30m, group by jsonPayload.event. If
    it started right after a deploy, roll back per infra/README.md.
  mimeType: text/markdown
conditions:
  - displayName: "api ERROR logs > 5 in 5m"
    conditionThreshold:
      filter: 'metric.type="logging.googleapis.com/user/api_error_logs" resource.type="cloud_run_revision"'
      comparison: COMPARISON_GT
      thresholdValue: 5
      duration: 0s
      aggregations:
        - alignmentPeriod: 300s
          perSeriesAligner: ALIGN_SUM
alertStrategy:
  autoClose: 1800s
notificationChannels:
  - ${CH}
EOF

cat > /tmp/m8-client.yaml <<EOF
displayName: "Olio SPA — client error spike"
combiner: OR
enabled: true
documentation:
  content: |
    The app/platform front-end is reporting browser crashes above normal
    (event=client.error). Often a bad frontend deploy white-screening users.
    First: Cloud Logging jsonPayload.event="client.error", last 30m, group by
    jsonPayload.app + path + message. Roll back the affected hosting site if it
    followed a deploy.
  mimeType: text/markdown
conditions:
  - displayName: "client.error reports > 10 in 5m"
    conditionThreshold:
      filter: 'metric.type="logging.googleapis.com/user/client_errors" resource.type="cloud_run_revision"'
      comparison: COMPARISON_GT
      thresholdValue: 10
      duration: 0s
      aggregations:
        - alignmentPeriod: 300s
          perSeriesAligner: ALIGN_SUM
alertStrategy:
  autoClose: 1800s
notificationChannels:
  - ${CH}
EOF

cat > /tmp/m8-stripe.yaml <<EOF
displayName: "Stripe platform Connect account disabled"
combiner: OR
enabled: true
documentation:
  content: |
    The Olio platform Stripe Connect account flipped chargesEnabled=false. Until
    resolved, every tenant rent-checkout 5xx's. First: open
    https://dashboard.stripe.com/account/status and clear the verification/
    compliance requirements; the mirror flips back when Stripe re-enables.
  mimeType: text/markdown
conditions:
  - displayName: "platform Connect disabled in last 1m"
    conditionThreshold:
      filter: 'metric.type="logging.googleapis.com/user/stripe_connect_charges_disabled" resource.type="cloud_run_revision"'
      comparison: COMPARISON_GT
      thresholdValue: 0
      duration: 60s
      aggregations:
        - alignmentPeriod: 60s
          perSeriesAligner: ALIGN_SUM
alertStrategy:
  autoClose: 1800s
notificationChannels:
  - ${CH}
EOF

gcloud alpha monitoring policies create --project="$P" --policy-from-file=/tmp/m8-api.yaml
gcloud alpha monitoring policies create --project="$P" --policy-from-file=/tmp/m8-client.yaml
gcloud alpha monitoring policies create --project="$P" --policy-from-file=/tmp/m8-stripe.yaml

echo
echo "Done. 3 metrics + 3 policies created, wired to ${CH}."
echo "If you haven't verified the email channel yet, click the link Google emailed to oliowallet@gmail.com."
