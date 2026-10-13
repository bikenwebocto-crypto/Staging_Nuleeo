import { useState } from "react";
import { Send } from "lucide-react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { sendTest } from "../api/campaigns";

export interface SendTestModalProps {
  campaignId: string;
  defaultEmail?: string;
  onClose: () => void;
  onSent?: () => void;
}

export function SendTestModal({ campaignId, defaultEmail, onClose, onSent }: SendTestModalProps) {
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSend = async () => {
    setSending(true);
    setError(null);
    try {
      await sendTest(campaignId, { email });
      setDone(true);
      onSent?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send test");
    } finally {
      setSending(false);
    }
  };

  // Shared ResponsiveDrawer = bottom-sheet on mobile / centered modal on desktop,
  // with role=dialog, aria-modal, focus-trap, Escape + a built-in close button
  // (the hand-rolled overlay had none of these). Parent mounts only while open,
  // so `open` stays true for this instance's lifetime.
  return (
    <ResponsiveDrawer
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Send test email"
      desktopMaxWidth="max-w-sm"
      footer={
        <button
          onClick={handleSend}
          disabled={sending || !email}
          className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-foreground text-background text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Send size={14} />
          {sending ? "Sending..." : done ? "Sent — send another?" : "Send test"}
        </button>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Recipient email
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className="w-full px-4 py-2.5 rounded-lg border border-border bg-muted text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoFocus
          />
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-xs text-success">
            Test sent. Check your inbox in a minute.
          </p>
        )}
      </div>
    </ResponsiveDrawer>
  );
}
