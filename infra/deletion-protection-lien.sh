#!/usr/bin/env bash
#
# Registers a GCP resource lien on the olio-wallet project that BLOCKS
# `gcloud projects delete` and the equivalent Firebase Console action.
# Without this, any co-owner with project-level admin rights can one-click
# tear down the entire project: Firestore data + Auth users + Storage
# bucket + Cloud Functions + Secrets. The Firebase Console offers a 30-day
# recovery window after which the project is unrecoverable.
#
# Idempotent: re-running with the same restriction is a no-op if a lien
# with the same scope already exists.
#
# Apply once per project; record the returned lien id in the ops runbook.
# To remove (when intentionally winding the project down):
#   gcloud resource-manager liens delete LIEN_ID
#
# Required: gcloud CLI authenticated as an owner of the olio-wallet project.

set -euo pipefail

PROJECT_ID="olio-wallet"
ORIGIN="manual-ops-runbook"
REASON="production property-management platform — deletion blocked, contact ops to remove this lien before any tear-down"

echo "Registering deletion-protection lien on project: ${PROJECT_ID}"
echo "Reason: ${REASON}"
echo

gcloud resource-manager liens create \
  --project="${PROJECT_ID}" \
  --restrictions=resourcemanager.projects.delete \
  --origin="${ORIGIN}" \
  --reason="${REASON}"

echo
echo "Done. To list active liens on this project:"
echo "  gcloud resource-manager liens list --project=${PROJECT_ID}"
