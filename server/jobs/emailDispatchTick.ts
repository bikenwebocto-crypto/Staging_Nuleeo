// Email-campaign dispatch worker.
//
// Runs every minute (via Cloud Scheduler) AND inline immediately after a
// /send call so admins don't wait up to a minute for the first batch to fire.
//
// Per tick:
//   1. Find campaigns ready to send: status === "sending" OR
//      (status === "scheduled" AND scheduledAt <= now).
//   2. For each "scheduled" one, transactionally flip to "sending".
//   3. Pull up to BATCH_SIZE queued recipients per campaign.
//   4. For each: render the email, hand to Resend, write the result back.
//   5. When the queue drains, flip campaign to "sent" and stamp sentAt.
//
// Idempotency: every recipient write is keyed by uid, so a re-run finds them
// already in a terminal state and skips. The transaction-flip on "scheduled"
// → "sending" guards against two ticks racing on the same campaign.

import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebase";
import {
  COL,
  SUBCOL_EMAIL_RECIPIENTS,
  type EmailCampaign,
  type EmailRecipient,
  type User,
} from "../../shared/firestore-schema";
import { ResendError, readResendUsage, sendEmailViaResend } from "../services/resend";
import { logError, logInfo, logWarn } from "../services/log";
import { renderTemplate, wrapInEmailShell } from "../services/mergeVars";
import { buildUnsubscribeUrl } from "../services/unsubscribe";

// One Resend request per recipient, sequential within a campaign so we don't
// dogpile the API. Cross-campaign work is naturally serial because the
// scheduler fires once per minute.
const BATCH_SIZE = 100;

// Friendly tag value for analytics — Resend only allows ASCII letters,
// numbers, underscores, and dashes here (see sanitizeResendTag). Maps any of
// the three audience encodings into a stable label so charts don't fragment
// when a campaign uses a filter vs the legacy enum. NOTE the separator is an
// underscore, NOT a colon: a colon is outside Resend's tag charset and makes
// it 422 the whole send. sanitizeResendTag is the backstop, but keep this
// value clean at the source so the tag reads correctly in the dashboard.
function campaignAudienceTag(c: EmailCampaign): string {
  if (c.targetUserId) return "user";
  if (c.filter) return `filter_${c.filter.role}`;
  return c.audience ?? "unknown";
}

export async function runEmailDispatchTick(): Promise<void> {
  const now = new Date().toISOString();

  // Two narrow queries beat one OR query: Firestore doesn't natively OR
  // across different field predicates without a composite index we'd have to
  // ship in firestore.indexes.json.
  const [sendingSnap, scheduledSnap] = await Promise.all([
    db().collection(COL.emailCampaigns).where("status", "==", "sending").get(),
    db()
      .collection(COL.emailCampaigns)
      .where("status", "==", "scheduled")
      .where("scheduledAt", "<=", now)
      .get(),
  ]);

  const campaigns: { id: string; data: EmailCampaign }[] = [];
  for (const d of sendingSnap.docs) campaigns.push({ id: d.id, data: d.data() as EmailCampaign });
  for (const d of scheduledSnap.docs) {
    // Promote scheduled → sending atomically. If another tick won the race
    // we'll see status !== "scheduled" inside the txn and bail.
    const ref = d.ref;
    const promoted = await db().runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) return null;
      const c = fresh.data() as EmailCampaign;
      if (c.status !== "scheduled") return null;
      tx.update(ref, { status: "sending", updatedAt: new Date().toISOString() });
      return { ...c, status: "sending" as const };
    });
    if (promoted) campaigns.push({ id: d.id, data: promoted });
  }

  for (const c of campaigns) {
    try {
      await dispatchOneCampaign(c.id);
    } catch (err) {
      // Per-campaign failures shouldn't sink the tick.
      logError("email_dispatch.campaign-failed", err, { campaignId: c.id });
    }
  }
}

async function dispatchOneCampaign(campaignId: string): Promise<void> {
  const campaignRef = db().collection(COL.emailCampaigns).doc(campaignId);
  const recipientsRef = campaignRef.collection(SUBCOL_EMAIL_RECIPIENTS);

  // Cancellation check before each batch.
  const head = await campaignRef.get();
  if (!head.exists) return;
  const campaign = head.data() as EmailCampaign;
  if (campaign.status !== "sending") return;

  // STUCK-SENDING RECOVERY. The per-recipient claim transaction (below)
  // flips status from "queued" → "sending" before the Resend call. If
  // the function crashes / times out / cold-evicts between the claim
  // and the post-send update, the row stays "sending" forever — the
  // campaign would otherwise sit at "sending" past 100% queue drain
  // and never flip to "sent" because there are no more queued rows.
  // Reclaim by rolling stale (>5min old) "sending" rows back to
  // "queued" so the next claim picks them up. 5min is safely past the
  // Functions max execution window so we never preempt a live send.
  const STUCK_CUTOFF_ISO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  try {
    const stuckSnap = await recipientsRef
      .where("status", "==", "sending")
      .where("claimedAt", "<", STUCK_CUTOFF_ISO)
      .limit(BATCH_SIZE)
      .get();
    if (!stuckSnap.empty) {
      const recoverBatch = db().batch();
      stuckSnap.docs.forEach((d) => {
        recoverBatch.update(d.ref, { status: "queued", claimedAt: FieldValue.delete() });
      });
      await recoverBatch.commit();
      logInfo("email_dispatch.stuck-recovered", {
        campaignId,
        recoveredCount: stuckSnap.size,
      });
    }
  } catch (err) {
    logWarn("email_dispatch.stuck-recovery-failed", {
      campaignId,
      err: String(err).slice(0, 200),
    });
  }

  const queuedSnap = await recipientsRef.where("status", "==", "queued").limit(BATCH_SIZE).get();

  if (queuedSnap.empty) {
    // Defensive: also check there are no "sending" rows lingering — if
    // there are, we just rolled them back above and the NEXT tick will
    // drain them. Don't flip the campaign to "sent" yet, or we'd
    // report 100% complete while there's still actual work to do.
    const sendingSnap = await recipientsRef.where("status", "==", "sending").limit(1).get();
    if (!sendingSnap.empty) return;

    // Nothing queued + nothing in-flight: campaign is done.
    await campaignRef.update({
      status: "sent",
      sentAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return;
  }

  // Batch-fetch user names for this tick so {{name}} / {{first_name}} /
  // {{last_name}} merge tokens render correctly. The recipient doc only
  // persists userId+email; without this lookup, every send goes out with
  // empty names and the {{name}} fallback ("there") replaces every greeting.
  //
  // We also carry the marketing opt-out pref off the same read so we can
  // re-check it at send-time (see the claim loop below): the audience
  // snapshot only filters marketingEmails === false at queue time, so a
  // user who unsubscribes AFTER the campaign is queued would otherwise
  // still receive the email. Re-reading here closes that compliance gap
  // for the common case; the per-recipient claim txn re-reads the pref
  // again for users who flip it between this batch fetch and their send.
  const userIds = Array.from(
    new Set(
      queuedSnap.docs
        .map((d) => (d.data() as EmailRecipient).userId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  );
  const userInfoById = new Map<
    string,
    { firstName: string; lastName: string; marketingOptedOut: boolean }
  >();
  if (userIds.length > 0) {
    const userRefs = userIds.map((id) => db().collection(COL.users).doc(id));
    const userSnaps = await db().getAll(...userRefs);
    for (const snap of userSnaps) {
      if (!snap.exists) continue;
      const u = snap.data() as User;
      userInfoById.set(snap.id, {
        firstName: u.firstName ?? "",
        lastName: u.lastName ?? "",
        // Mirror the audiences.ts snapshot semantics: missing/undefined
        // pref = opted IN (default-opt-in); only an explicit `false` blocks.
        marketingOptedOut: u.notificationPrefs?.marketingEmails === false,
      });
    }
  }

  // QUOTA GATE. Read the current Resend daily/monthly usage and only send up
  // to the remaining headroom this batch. Without this, a campaign larger than
  // the Resend ceiling (or repeated campaigns) drains the shared allowance and
  // then ALL email — including transactional password resets / invites — fails
  // until the next billing cycle. When we hit the wall we leave the rest
  // "queued" (campaign stays "sending") so the next tick resumes once the
  // period rolls over or the plan limit is raised. Note: two concurrent ticks
  // (inline /send kick + cron) each read this snapshot independently, so a
  // single minute can overshoot by at most one batch; the next tick sees
  // used >= limit and stops — bounded, not unbounded.
  let usageHeadroom = Infinity;
  try {
    usageHeadroom = (await readResendUsage()).headroom;
  } catch (err) {
    // A quota-read failure must not wedge legitimate sends; fall back to
    // sending the batch (the post-send counter still records usage).
    logWarn("email_dispatch.quota-read-failed", { campaignId, err: String(err).slice(0, 200) });
  }
  if (usageHeadroom <= 0) {
    logWarn("email_dispatch.quota-exhausted", { campaignId });
    return;
  }
  let sentThisBatch = 0;

  for (const rDoc of queuedSnap.docs) {
    // Stop once this batch has consumed the available quota headroom — leave
    // the remaining recipients "queued" for a later tick (don't claim them).
    if (sentThisBatch >= usageHeadroom) {
      logInfo("email_dispatch.quota-batch-capped", { campaignId, sentThisBatch });
      break;
    }
    const recipient = rDoc.data() as EmailRecipient;
    const attemptedAt = new Date().toISOString();
    const userInfo = recipient.userId ? userInfoById.get(recipient.userId) : undefined;
    const names = userInfo ?? { firstName: "", lastName: "" };

    // Atomically CLAIM the recipient before sending. Without this,
    // the inline /send kick + the scheduled cron tick can each pull
    // the same `status: queued` batch and both fire sendEmailViaResend
    // to the same email — every recipient gets duplicate messages +
    // acceptedCount double-increments. The transaction re-reads the
    // recipient inside the txn and only proceeds if status is still
    // "queued" (some other tick may have already claimed it).
    //
    // We mark `status: "sending"` + `claimedAt` so a tick that crashes
    // mid-send doesn't leave the recipient stuck forever — a future
    // pass can be taught to re-claim "sending" rows older than N min
    // if recovery becomes important. For now a stuck "sending" just
    // means that recipient isn't retried; better than a duplicate.
    const claimed = await db().runTransaction(async (t) => {
      const fresh = await t.get(rDoc.ref);
      if (!fresh.exists) return false;
      const data = fresh.data() as EmailRecipient;
      if (data.status !== "queued") return false;
      t.update(rDoc.ref, {
        status: "sending",
        claimedAt: attemptedAt,
      });
      return true;
    });
    if (!claimed) continue;

    // RE-CHECK MARKETING OPT-OUT AT SEND-TIME. The audience snapshot only
    // filtered marketingEmails === false when the campaign was queued. A
    // user who unsubscribes (Settings toggle, footer link, or a Resend
    // complaint webhook flipping the pref) AFTER queueing but BEFORE this
    // tick reaches their row must NOT receive the email — sending anyway
    // is a compliance violation. We re-read the pref fresh here (rather
    // than trusting the batch fetch above, which is one read per tick and
    // can be stale by the time sequential sends reach this recipient) and,
    // if they've opted out, mark the recipient "unsubscribed" + bump the
    // campaign's unsubscribedCount — mirroring the Resend complaint handler
    // in emailMarketing.ts — instead of sending. This only gates marketing
    // campaigns; transactional/system mail never flows through this worker.
    let marketingOptedOut = userInfo?.marketingOptedOut ?? false;
    if (!marketingOptedOut && recipient.userId) {
      try {
        const freshUser = await db().collection(COL.users).doc(recipient.userId).get();
        if (freshUser.exists) {
          marketingOptedOut =
            (freshUser.data() as User).notificationPrefs?.marketingEmails === false;
        }
      } catch (err) {
        // A failed pref read shouldn't block a legitimate send; the batch
        // value (default opt-in) already gave us a best-effort answer.
        logWarn("email_dispatch.optout-recheck-failed", {
          campaignId,
          err: String(err).slice(0, 200),
        });
      }
    }
    if (marketingOptedOut) {
      await rDoc.ref.update({
        status: "unsubscribed",
        attemptedAt,
      });
      await campaignRef.update({
        unsubscribedCount: FieldValue.increment(1),
        updatedAt: attemptedAt,
      });
      logInfo("email_dispatch.suppressed-optout", {
        campaignId,
        userId: recipient.userId,
      });
      continue;
    }

    // Per-recipient unsubscribe URL: a signed token that only flips THIS
    // user's preference. Generated fresh per send so a rotated secret
    // immediately invalidates any links still in the wild.
    let unsubscribeUrl: string | undefined;
    try {
      unsubscribeUrl = buildUnsubscribeUrl(recipient.userId);
    } catch {
      // UNSUBSCRIBE_SECRET not set — fall back to a Settings link in the
      // footer rather than blocking the send.
      unsubscribeUrl = undefined;
    }

    const mergeCtx = {
      recipient: {
        userId: recipient.userId,
        email: recipient.email,
        firstName: names.firstName,
        lastName: names.lastName,
      },
      unsubscribeUrl,
    };
    const renderedBody = renderTemplate(campaign.bodyText, mergeCtx);
    const renderedSubject = renderTemplate(campaign.subject, mergeCtx);
    // Signature + footer support the same {{merge}} vars as the body. The CTA
    // label is merge-rendered too; its URL is kept literal (validated http(s)
    // at authoring time) so no substitution can smuggle a bad protocol in.
    const renderedSignature = campaign.signature
      ? renderTemplate(campaign.signature, mergeCtx)
      : undefined;
    const renderedFooter = campaign.footerText
      ? renderTemplate(campaign.footerText, mergeCtx)
      : undefined;
    const renderedCta = campaign.cta
      ? { label: renderTemplate(campaign.cta.label, mergeCtx), url: campaign.cta.url }
      : undefined;
    const { html, text } = wrapInEmailShell({
      subject: renderedSubject,
      body: renderedBody,
      unsubscribeUrl,
      cta: renderedCta,
      signature: renderedSignature,
      footerText: renderedFooter,
    });

    try {
      const result = await sendEmailViaResend({
        to: recipient.email,
        subject: renderedSubject,
        html,
        text,
        unsubscribeUrl,
        tags: [
          { name: "campaign_id", value: campaignId },
          { name: "audience", value: campaignAudienceTag(campaign) },
        ],
      });
      await rDoc.ref.update({
        status: "accepted",
        providerMessageId: result.id,
        attemptedAt,
      });
      // Only an accepted send consumes Resend quota (incrementResendUsage bumps
      // on 200/202); opt-outs and failures below don't, so count it here.
      sentThisBatch += 1;
      await campaignRef.update({
        acceptedCount: FieldValue.increment(1),
        updatedAt: attemptedAt,
      });
    } catch (err) {
      const message =
        err instanceof ResendError ? err.message : err instanceof Error ? err.message : String(err);
      await rDoc.ref.update({
        status: "failed",
        error: message.slice(0, 500),
        attemptedAt,
      });
      await campaignRef.update({
        failedCount: FieldValue.increment(1),
        updatedAt: attemptedAt,
      });
    }
  }

  // If we just sent the last queued message, finish the campaign.
  // Two-stage check: (a) no more queued AND (b) no "sending" rows
  // still in flight from THIS or another tick. Without the second
  // check, a crash that left a stuck-"sending" row would let us flip
  // the campaign to "sent" prematurely and report < 100% delivery
  // forever (sum of accepted+failed would never equal recipientCount).
  const remainingQueued = await recipientsRef.where("status", "==", "queued").limit(1).get();
  if (!remainingQueued.empty) return;
  const remainingSending = await recipientsRef.where("status", "==", "sending").limit(1).get();
  if (!remainingSending.empty) return;
  await campaignRef.update({
    status: "sent",
    sentAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
