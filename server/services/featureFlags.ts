// Runtime feature kill-switches. Lets a superadmin disable a risky money/abuse
// path at runtime (no deploy) by flipping config/featureFlags — the "stop the
// bleeding" lever referenced in the SECURITY.md incident runbook. Backed by the
// 30s-TTL config cache, so a toggle propagates across all function instances
// within the cache window. Toggle via PUT /api/feature-flags (superadmin) or by
// editing the Firestore doc directly.

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { loadFeatureFlags } from "./configCache";
import { logWarn } from "./log";
import type { FeatureFlag } from "../../shared/firestore-schema";

// A flag is ENABLED unless explicitly set to false — so a missing flag, or a
// whole missing config/featureFlags doc, reads as on. Fails OPEN: if the flags
// doc can't be read, we do NOT take the feature down (the kill-switch is a
// deliberate operator OFF, never an accidental side effect of a transient read
// error on the money path).
export async function isFeatureEnabled(flag: FeatureFlag): Promise<boolean> {
  try {
    const config = await loadFeatureFlags();
    return config.flags[flag] !== false;
  } catch {
    return true;
  }
}

// Express middleware: 503 a request when its feature is killed. Mount on the
// risky paths (rent checkout, Connect onboarding, plan upgrade, AskOlio) so a
// superadmin can stop the bleeding instantly. async, but never rejects — the
// isFeatureEnabled read is internally caught.
export function requireFeature(flag: FeatureFlag): RequestHandler {
  return async (_req: Request, res: Response, next: NextFunction) => {
    if (await isFeatureEnabled(flag)) return next();
    logWarn("feature.disabled-request-blocked", { flag });
    res.status(503).json({
      error: "This feature is temporarily unavailable. Please try again shortly.",
    });
  };
}
