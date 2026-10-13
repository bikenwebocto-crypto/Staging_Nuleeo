import { useState } from "react";
import { ResponsiveDrawer } from "@ui/components/common/ResponsiveDrawer";
import { apiRequest } from "@ui/lib/queryClient";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { TicketPriority } from "@shared/firestore-schema";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitId: string;
  propertyId: string;
  unitLabel: string;
}

const PRIORITIES: { value: TicketPriority; label: string; tone: string }[] = [
  { value: "low", label: "Low", tone: "bg-muted text-muted-foreground" },
  { value: "medium", label: "Medium", tone: "bg-blue-500/15 text-blue-500 border-blue-500/30" },
  { value: "high", label: "High", tone: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  { value: "urgent", label: "Urgent", tone: "bg-red-500/15 text-red-500 border-red-500/30" },
];

export function ReportProblemDrawer({ open, onOpenChange, unitId, propertyId, unitLabel }: Props) {
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TicketPriority>("medium");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSubject("");
    setDescription("");
    setPriority("medium");
    setSuccess(false);
    setError(null);
  }

  async function submit() {
    if (!subject.trim() || !description.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await apiRequest("POST", "/api/tickets", {
        subject: subject.trim(),
        description: description.trim(),
        category: "property",
        priority,
        propertyId,
        unitId,
      });
      setSuccess(true);
      queryClient.invalidateQueries({ queryKey: ["/api/tenant/activity"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to submit report");
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Reset on close so the next open is clean.
      setTimeout(reset, 200);
    }
  }

  return (
    <ResponsiveDrawer
      open={open}
      onOpenChange={handleClose}
      title="Report a Problem"
      subtitle={unitLabel}
    >
      {success ? (
        <div className="py-10 flex flex-col items-center text-center">
          <div className="w-14 h-14 rounded-full bg-green-500/15 border border-green-500/30 flex items-center justify-center mb-4">
            <CheckCircle2 size={26} className="text-green-500" />
          </div>
          <h3 className="text-lg font-bold text-foreground mb-1.5">Report sent</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            We've logged your report — your landlord will be notified if they have notifications on.
            You can track progress in your activity feed.
          </p>
          <button
            onClick={() => handleClose(false)}
            className="mt-6 bg-foreground text-background font-semibold px-6 py-2.5 rounded-xl text-sm hover:opacity-90 transition"
          >
            Done
          </button>
        </div>
      ) : (
        <div className="space-y-4 pb-2">
          <div>
            <label className="text-xs font-semibold text-foreground mb-1.5 block uppercase tracking-wide">
              What's wrong?
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Broken AC, leaking tap, …"
              maxLength={200}
              className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/20"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-foreground mb-1.5 block uppercase tracking-wide">
              Priority
            </label>
            <div className="grid grid-cols-4 gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPriority(p.value)}
                  className={`py-2 rounded-xl text-xs font-semibold border transition ${
                    priority === p.value
                      ? `${p.tone} border-current`
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-foreground mb-1.5 block uppercase tracking-wide">
              Details
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what's happening, when it started, anything you've tried…"
              maxLength={4000}
              rows={5}
              className="w-full bg-muted/50 border border-border rounded-xl px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-foreground/20 resize-none"
            />
            <p className="text-[11px] text-muted-foreground/70 mt-1">{description.length} / 4000</p>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-xs">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={submit}
            disabled={!subject.trim() || !description.trim() || submitting}
            className="w-full bg-foreground text-background font-bold py-3.5 rounded-2xl text-sm hover:opacity-90 transition active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            {submitting ? "Sending…" : "Send report"}
          </button>
        </div>
      )}
    </ResponsiveDrawer>
  );
}
