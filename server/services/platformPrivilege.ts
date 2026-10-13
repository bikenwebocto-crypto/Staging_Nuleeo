// Platform-role privilege resolution. Shared between routes.ts (which
// uses these to build the requirePlatformPrivilege middleware) and
// per-domain route modules that need to gate inner branches on a
// finer-grained privilege than the outer middleware.
//
//   resolvePlatformRole(profile)  → "superadmin" | PlatformRoleKey | null
//   hasPlatformPrivilege(profile) → matrix lookup, superadmin shortcut
//   isLastSuperadmin(uid)         → guard for last-superadmin lockout

import { db } from "../firebase";
import { loadPrivilegesConfig } from "./configCache";
import {
  COL,
  type PlatformPrivilegeKey,
  type PlatformRoleKey,
  type User,
} from "../../shared/firestore-schema";

// Effective platform role of the caller. Superadmin bypasses the
// matrix; admins fall back to "admin" when no sub-role is set.
export function resolvePlatformRole(
  profile: User | undefined,
): PlatformRoleKey | "superadmin" | null {
  if (!profile) return null;
  if (profile.roles.includes("superadmin")) return "superadmin";
  if (profile.roles.includes("admin")) return profile.platformRole ?? "admin";
  return null;
}

export async function hasPlatformPrivilege(
  profile: User | undefined,
  privilege: PlatformPrivilegeKey,
): Promise<boolean> {
  const role = resolvePlatformRole(profile);
  if (role === null) return false;
  if (role === "superadmin") return true;
  const config = await loadPrivilegesConfig();
  return Boolean(config.platform[privilege]?.[role]);
}

// Refuse to remove the last superadmin (suspend, delete, or demote-
// via-PATCH) so we don't leave the platform with zero superadmins —
// a recoverable lockout (you'd have to fix it via Firestore directly),
// but worth one cheap query to prevent. Counts every role-bearing doc
// regardless of status, so a "suspended" superadmin still counts as
// recoverable cover.
export async function isLastSuperadmin(userId: string): Promise<boolean> {
  const snap = await db()
    .collection(COL.users)
    .where("roles", "array-contains", "superadmin")
    .get();
  for (const doc of snap.docs) {
    if (doc.id !== userId) return false;
  }
  return true;
}
