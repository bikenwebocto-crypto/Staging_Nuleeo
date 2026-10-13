// Self-delete UI (GDPR Article 17 — right to erasure). Typed-email confirm
// gate, then DELETE /api/me, sign out, hard-redirect so React Query cache
// and every in-memory store gets cleared by the navigation. Used by the
// Privacy & Terms tab list on both the drawer sub-view and the
// /profile/privacy page.

import { useState } from "react";
import { Trash2, Download } from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest, parseApiError } from "@ui/lib/queryClient";

interface Props {
  // Where to send the user after the account is gone. Default matches the
  // user-app subdomain's /auth route. Admin platform passes "/login".
  signOutRedirect?: string;
}

export function DeleteAccountSection({ signOutRedirect = "/auth" }: Props) {
  const { profile, firebaseUser, signOut } = useAuth();
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  async function handleDelete() {
    setError("");
    const expected = (profile?.email ?? firebaseUser?.email ?? "").trim().toLowerCase();
    if (!expected) {
      setError("Your email is missing from the session. Sign out and back in, then retry.");
      return;
    }
    if (confirmText.trim().toLowerCase() !== expected) {
      setError("Type your email exactly to confirm.");
      return;
    }
    setBusy(true);
    try {
      await apiRequest("DELETE", "/api/me");
      await signOut();
      window.location.href = signOutRedirect;
    } catch (err) {
      setError(parseApiError(err, "Could not delete account. Try again."));
      setBusy(false);
    }
  }

  async function handleExport() {
    setExportError("");
    setExporting(true);
    try {
      const res = await apiRequest("GET", "/api/me/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `olio-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(parseApiError(err, "Could not prepare your data export. Try again."));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-card p-5 rounded-3xl border border-border shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <Download size={18} className="text-foreground" />
          <h3 className="text-base font-semibold text-foreground">Download your data</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
          Get a machine-readable (JSON) copy of the data Olio holds about you — your profile,
          tenancies, agreements, payment history, documents and messages (your GDPR rights of access
          and portability).
        </p>
        {exportError && (
          <p className="text-sm text-destructive mb-3" role="alert">
            {exportError}
          </p>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="w-full py-2.5 rounded-lg bg-secondary text-foreground text-sm font-semibold hover:bg-secondary/80 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {exporting ? "Preparing…" : "Download my data"}
        </button>
      </div>

      <div className="bg-card p-5 rounded-3xl border border-destructive/30 shadow-sm">
        <div className="flex items-center gap-2 mb-1">
          <Trash2 size={18} className="text-destructive" />
          <h3 className="text-base font-semibold text-foreground">Delete account</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4 leading-relaxed">
          Permanently removes your account, your stored documents and photos, your tenancy + payment
          history, and every reference to you across the platform. This can't be undone.
        </p>
        <div className="bg-warning/10 border border-warning/20 rounded-xl p-3 mb-4 text-xs text-warning">
          You can't delete while you own live properties or have active tenancies — wind those down
          first or contact support.
        </div>
        <label className="text-sm font-medium text-foreground mb-1.5 block">
          Type your email to confirm
        </label>
        <input
          type="text"
          placeholder={profile?.email ?? firebaseUser?.email ?? "your@email.com"}
          value={confirmText}
          onChange={(e) => {
            setConfirmText(e.target.value);
            setError("");
          }}
          className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-destructive/20 focus:border-destructive/60"
          autoComplete="off"
          spellCheck={false}
        />
        {error && (
          <p className="text-sm text-destructive mt-3" role="alert">
            {error}
          </p>
        )}
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy || !confirmText.trim()}
          className="w-full mt-5 py-2.5 rounded-lg bg-destructive text-destructive-foreground text-sm font-semibold hover:bg-destructive/90 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? "Deleting…" : "Delete forever"}
        </button>
      </div>
    </div>
  );
}
