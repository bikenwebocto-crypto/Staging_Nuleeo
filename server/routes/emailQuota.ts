// Resend email-quota visibility endpoint:
//
//   GET /api/admin/email-quota — current daily + monthly send counts
//                                vs the Resend free-tier ceilings.
//
// Gated on `comm.email` (same as other Resend / push integration
// surfaces) so anyone who can manage email campaigns can see whether we
// are about to hit the quota wall. Hitting it would silently break all
// email — password resets, invites, marketing — until the next billing
// cycle, so this is operational telemetry, not a marketing feature.
//
// Counters are bumped from server/services/resend.ts on every successful
// send. We just read them here. If the doc doesn't exist yet (e.g. no
// sends have happened today) we return zero — that's the correct quota
// reading, not an error.

import type { Express, RequestHandler } from "express";
import { db } from "../firebase";
import { requireAuth } from "../auth";
import { errMsg } from "../services/errMsg";
import {
  RESEND_DAILY_LIMIT,
  RESEND_MONTHLY_LIMIT,
  dailyQuotaDocId,
  dailyQuotaKey,
  monthlyQuotaDocId,
  monthlyQuotaKey,
} from "../services/resend";
import { COL, type PlatformPrivilegeKey, type Role } from "../../shared/firestore-schema";

export interface EmailQuotaDeps {
  requireRole: (...roles: Role[]) => RequestHandler;
  requirePlatformPrivilege: (p: PlatformPrivilegeKey) => RequestHandler;
}

interface QuotaResponse {
  dailyUsed: number;
  dailyLimit: number;
  monthlyUsed: number;
  monthlyLimit: number;
  dailyDate: string;
  monthlyMonth: string;
  percentDaily: number;
  percentMonthly: number;
}

function asCount(data: FirebaseFirestore.DocumentData | undefined): number {
  if (!data) return 0;
  const raw = data.count;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return 0;
}

export function registerEmailQuotaRoutes(
  app: Express,
  { requireRole, requirePlatformPrivilege }: EmailQuotaDeps,
): void {
  app.get(
    "/api/admin/email-quota",
    requireAuth,
    requireRole("admin", "superadmin"),
    requirePlatformPrivilege("comm.email"),
    async (_req, res) => {
      try {
        const now = new Date();
        const dailyDate = dailyQuotaKey(now);
        const monthlyMonth = monthlyQuotaKey(now);
        const col = db().collection(COL.config);
        const [dailySnap, monthlySnap] = await Promise.all([
          col.doc(dailyQuotaDocId(dailyDate)).get(),
          col.doc(monthlyQuotaDocId(monthlyMonth)).get(),
        ]);
        const dailyUsed = asCount(dailySnap.exists ? dailySnap.data() : undefined);
        const monthlyUsed = asCount(monthlySnap.exists ? monthlySnap.data() : undefined);
        const payload: QuotaResponse = {
          dailyUsed,
          dailyLimit: RESEND_DAILY_LIMIT,
          monthlyUsed,
          monthlyLimit: RESEND_MONTHLY_LIMIT,
          dailyDate,
          monthlyMonth,
          // Pre-computed here so the widget never has to think about
          // div-by-zero (limits are constants > 0) and admins always see
          // the same rounding everywhere.
          percentDaily: Math.min(100, Math.round((dailyUsed / RESEND_DAILY_LIMIT) * 100)),
          percentMonthly: Math.min(100, Math.round((monthlyUsed / RESEND_MONTHLY_LIMIT) * 100)),
        };
        res.json(payload);
      } catch (err) {
        res.status(500).json({ error: errMsg(err, "Failed to read email quota") });
      }
    },
  );
}
