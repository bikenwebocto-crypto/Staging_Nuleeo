import type { AuthError } from "firebase/auth";

// Maps a Firebase re-authentication / credential error to a short, user-facing
// message. Shared by the admin Settings page (maintenance-mode re-auth) and the
// admin Profile Settings page (profile-save re-auth) — both prompt for the
// password and re-authenticate before a sensitive action, so they show the same
// copy.
export function reauthErrorMessage(err: unknown): string {
  const code = (err as AuthError)?.code ?? "";
  switch (code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect password. Please try again.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again in a moment.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    default:
      return (err as Error)?.message ?? "Something went wrong. Please try again.";
  }
}
