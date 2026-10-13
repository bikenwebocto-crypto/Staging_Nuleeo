import type { Plan, User } from "@shared/firestore-schema";

// Single source of truth for "should this account see the owner UI?".
//
// Rule: owner mode is an explicit opt-in stored on the user doc. New signups
// default to `ownerModeEnabled=false`, so they only see the tenant experience
// until they flip the Activate Landlord View toggle in Tenant Settings.
//
// Legacy fallback: pre-existing users (saved before this field shipped) have
// `ownerModeEnabled === undefined`. For those, fall back to the old rule —
// they already paid or were granted the owner role, so don't strip the UI
// out from under them on first load after deploy.
export function isOwnerExperience(
  profile: Pick<User, "roles" | "ownerModeEnabled">,
  plan: Plan,
): boolean {
  if (typeof profile.ownerModeEnabled === "boolean") {
    return profile.ownerModeEnabled;
  }
  // `roles` is typed as required but can be absent on legacy/partial docs;
  // guard so a missing array can't crash this hot path (see useAuth normalize).
  return (profile.roles?.includes("owner") ?? false) || plan !== "basic";
}
