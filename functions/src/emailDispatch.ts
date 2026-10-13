// Scheduled function that drives the email-campaign dispatcher. Fires every
// minute; the worker exits quickly when there's nothing queued, so a per-run
// cost is negligible. Required Resend secrets are bound by the caller in
// index.ts so they surface as process.env.* at runtime.

import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { runEmailDispatchTick } from "../../server/jobs/emailDispatchTick";

// firebase-functions doesn't publicly re-export the SecretParam type, so we
// derive it from defineSecret's return type instead of importing.
type SecretParam = ReturnType<typeof defineSecret>;

export function makeDispatchEmailCampaigns(secrets: SecretParam[]) {
  return onSchedule(
    {
      region: "europe-west1",
      schedule: "every 1 minutes",
      timeZone: "Europe/Athens",
      // 9 minutes — the default 60s wasn't enough headroom. BATCH_SIZE=100
      // recipients × per-call Resend latency + retries (up to ~1.25s on
      // transient failures) can push a single tick past 60s under load.
      // Per-recipient docs are idempotent on uid so a partial tick is
      // safely resumable on the next fire, but timing out mid-batch
      // wastes work + logs noise.
      timeoutSeconds: 540,
      secrets,
    },
    async () => {
      await runEmailDispatchTick();
    },
  );
}
