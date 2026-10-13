// Auth state context: subscribes to Firebase auth state and (when signed in)
// loads the user's Firestore profile via /api/me. Used to gate routes and to
// drive role-based default landing.
//
// Used by client/app and client/platform; landing should not import this.

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  onAuthStateChanged,
  onIdTokenChanged,
  signOut as fbSignOut,
  type User as FirebaseUser,
} from "firebase/auth";
import { auth } from "./firebase";
import { queryClient } from "./queryClient";
import type { User, PortfolioBanking } from "@shared/firestore-schema";

// /api/me returns the User doc with banking fields hydrated from the linked
// portfolio (loadPortfolioBanking). Banking was moved off the User doc onto
// the portfolios collection, so the profile is a User plus the portfolio's
// banking fields.
type Profile = User & Partial<PortfolioBanking>;

// localStorage keys that hold per-user state and must be wiped when the
// signed-in user changes. Without this, on a shared device user B sees
// user A's cached property draft, banner selection, accent color, etc.
const USER_SCOPED_LOCALSTORAGE_KEYS = [
  "olio_property_draft",
  "olio_active_portfolio",
  "olio_accent_color",
  "admin_banner_selection_cache",
];

interface AuthState {
  // Firebase Auth user (identity); null when signed out.
  firebaseUser: FirebaseUser | null;
  // Olio user profile from Firestore (roles, plan, etc.); null when signed out
  // or while still loading after sign-in.
  profile: Profile | null;
  // True until the first onAuthStateChanged fires (and any profile fetch resolves).
  loading: boolean;
  // Set when the most recent /api/me call failed. Consumers should show an
  // error+retry UI instead of waiting indefinitely for `profile`.
  profileError: Error | null;
  // True when /api/me returned 403 because the user is suspended. Distinct
  // from `profileError` so the UI can show a dedicated "account suspended"
  // screen instead of a generic retry dialog.
  suspended: boolean;
  signOut: () => Promise<void>;
  // Force-refresh the profile (e.g. after onboarding completes, or to retry
  // after a failed load).
  refreshProfile: () => Promise<void>;
  // Reload the Firebase user (after linking/unlinking a provider, adding a
  // password, or changing email) so every consumer re-reads providerData /
  // email. firebaseUser.reload() mutates the existing object in place — the
  // reference is unchanged, so React won't re-render on its own. This bumps an
  // internal version to force a re-render across all useAuth() consumers.
  refreshFirebaseUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileError, setProfileError] = useState<Error | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [loading, setLoading] = useState(true);
  // Bumped whenever the Firebase user's providers/email change in place
  // (link/unlink/add-password/email-change). Including it in the context value
  // forces every useAuth() consumer to re-render and re-read providerData even
  // though the FirebaseUser object reference is unchanged after reload().
  const [authVersion, setAuthVersion] = useState(0);
  // Monotonic token so a SLOW /api/me response can't clobber a newer one. Auth
  // events (sign-in, token refresh, manual refreshProfile) can fire loadProfile
  // again before an earlier fetch resolves; without this the stale earlier
  // response could overwrite the fresher profile. Each call captures its seq and
  // bails at every await boundary if a newer call has since started.
  const loadSeq = useRef(0);

  async function loadProfile() {
    const seq = ++loadSeq.current;
    const isStale = () => seq !== loadSeq.current;
    try {
      const user = auth.currentUser;
      const headers: Record<string, string> = user
        ? { Authorization: `Bearer ${await user.getIdToken()}` }
        : {};
      const res = await fetch("/api/me", { headers });
      if (isStale()) return;
      if (res.ok) {
        const data = (await res.json()) as Profile;
        if (isStale()) return;
        // Normalize `roles` to an array. The schema types it as required, but a
        // legacy/partially-written user doc can come back without it, and several
        // consumers do `profile.roles.includes(...)` — which crashed the app in
        // production ("undefined is not an object (evaluating 't.roles.includes')").
        // Defaulting here makes every downstream read safe at the source.
        setProfile(data.roles ? data : { ...data, roles: [] });
        setProfileError(null);
        setSuspended(false);
        return;
      }
      // Parse the JSON error body so we can both detect the suspension case
      // and surface a clean message in ProfileLoadError (instead of the raw
      // `403: {"error":"..."}` text users used to see).
      let body: { error?: string } | null = null;
      try {
        body = (await res.json()) as { error?: string };
      } catch {
        // Non-JSON response (e.g. HTML error page from a proxy) — fall through.
      }
      if (res.status === 403 && typeof body?.error === "string" && /suspend/i.test(body.error)) {
        if (isStale()) return;
        setSuspended(true);
        setProfile(null);
        setProfileError(null);
        return;
      }
      throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    } catch (err) {
      if (isStale()) return;
      console.error("Failed to load /api/me:", err);
      setProfile(null);
      setSuspended(false);
      setProfileError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Reload the current Firebase user and force consumers to recompute their
  // provider/email-derived UI. Used by the Sign-in methods dialog after every
  // link/unlink/add-password so the host Settings pages stop showing stale
  // "Add password" / "Connected" state once the dialog closes.
  async function refreshFirebaseUser() {
    try {
      await auth.currentUser?.reload();
    } catch (err) {
      // Non-fatal: a failed reload just means the UI keeps the last-known
      // provider list until the next auth event. Log for debuggability.
      console.warn("refreshFirebaseUser: reload failed", err);
    }
    setFirebaseUser(auth.currentUser);
    setAuthVersion((v) => v + 1);
  }

  // Track the previously-signed-in uid so we can detect "different user
  // signed in on the same browser" — that's the shared-device kiosk
  // case where user B inheriting user A's cached data is a real leak.
  const previousUidRef = useRef<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      const newUid = user?.uid ?? null;
      const prevUid = previousUidRef.current;
      // SIGN-OUT or USER-SWITCH: wipe the React Query cache + the small
      // set of per-user localStorage keys. Without this, queries with
      // `staleTime: Infinity` (queryClient.ts) return the previous
      // user's data instantly, with no refetch, to whoever signs in
      // next — shared-device PII leak.
      if (prevUid && prevUid !== newUid) {
        try {
          queryClient.clear();
        } catch {}
        try {
          for (const key of USER_SCOPED_LOCALSTORAGE_KEYS) {
            localStorage.removeItem(key);
          }
        } catch {}
      }
      previousUidRef.current = newUid;

      setFirebaseUser(user);
      if (user) {
        await loadProfile();
      } else {
        setProfile(null);
        setProfileError(null);
        setSuspended(false);
      }
      setLoading(false);
    });
  }, []);

  // onAuthStateChanged only fires on sign-in / sign-out, not when the SAME
  // user's ID token refreshes after a provider link/unlink, add-password, or
  // a confirmed email change. Subscribe to onIdTokenChanged too and bump
  // authVersion so provider/email-derived UI updates without a manual reload.
  useEffect(() => {
    return onIdTokenChanged(auth, (user) => {
      if (user) setAuthVersion((v) => v + 1);
    });
  }, []);

  // `value` is a fresh object literal each render, so bumping authVersion
  // (which re-renders this provider) gives consumers a new reference and
  // forces them to re-read firebaseUser.providerData / .email. The reference
  // to authVersion here keeps the dependency explicit for future readers.
  void authVersion;
  const value: AuthState = {
    firebaseUser,
    profile,
    loading,
    profileError,
    suspended,
    signOut: () => fbSignOut(auth),
    refreshProfile: loadProfile,
    refreshFirebaseUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
