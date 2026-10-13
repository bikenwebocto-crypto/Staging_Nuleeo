import type { Request, Response, NextFunction } from "express";
import { auth, db } from "./firebase";
import { COL, type Role, type User } from "../shared/firestore-schema";

declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        email?: string;
        // OAuth-provider claims from the verified Firebase ID token. `name` and
        // `picture` are populated when the user signs in with Google (or any
        // other social provider that supplies them); empty for email/password.
        name?: string;
        picture?: string;
        // Use import-type to avoid the inner `User` resolving to Express.User
        // (which is the empty default interface), rather than our Firestore User.
        profile?: import("../shared/firestore-schema").User;
      };
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  const idToken = header.slice("Bearer ".length);
  try {
    const decoded = await auth().verifyIdToken(idToken);
    const profileSnap = await db().collection(COL.users).doc(decoded.uid).get();
    const profile = profileSnap.exists ? (profileSnap.data() as User) : undefined;
    // Resurrection guard: a hard-deleted (GDPR-erased) user keeps a valid ID
    // token for up to ~1h. With no backing profile, GET /api/me would otherwise
    // re-provision a brand-new active account, undoing the erasure. deleteUserCascade
    // writes a tombstone at deletedUsers/{uid}; reject any token marked there.
    // This lookup only runs when there's NO profile (deleted users + brand-new
    // signups about to be created), so the common authenticated path adds no read.
    // (We deliberately don't pass checkRevoked to verifyIdToken — that would add a
    // getUser round-trip to EVERY request; suspensions and role/plan changes are
    // already enforced live off the freshly-read profile below, and erasure is
    // covered here, so the per-request cost buys nothing.)
    if (!profile) {
      const tombstone = await db().collection(COL.deletedUsers).doc(decoded.uid).get();
      if (tombstone.exists) {
        return res.status(403).json({ error: "This account has been deleted." });
      }
    }
    // Suspended users are blocked from every authenticated endpoint —
    // both app (tenant/owner) and platform (admin) routes go through here.
    // Disabling the Firebase Auth account stops fresh sign-in; this check
    // stops anyone holding a still-valid ID token at the door.
    if (profile?.status === "suspended") {
      return res.status(403).json({ error: "Your account has been suspended. Contact support." });
    }
    req.user = {
      uid: decoded.uid,
      email: decoded.email,
      name: typeof decoded.name === "string" ? decoded.name : undefined,
      picture: typeof decoded.picture === "string" ? decoded.picture : undefined,
      profile,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userRoles = req.user?.profile?.roles ?? [];
    if (!roles.some((r) => userRoles.includes(r))) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}
