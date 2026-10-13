// Inline "send now / schedule for…" control. Date+time pickers stay native
// to dodge a date-library dependency; the parent owns the resulting ISO
// string and decides which campaign endpoint to call.

import { CalendarClock, SendHorizontal } from "lucide-react";

export interface ScheduleControlProps {
  mode: "now" | "schedule";
  scheduledAt: string | null;
  onModeChange: (mode: "now" | "schedule") => void;
  onScheduledAtChange: (iso: string | null) => void;
  disabled?: boolean;
}

export function ScheduleControl({
  mode,
  scheduledAt,
  onModeChange,
  onScheduledAtChange,
  disabled,
}: ScheduleControlProps) {
  // Native input value lives in local time without the timezone suffix.
  const localValue = scheduledAt ? toLocalInput(scheduledAt) : "";
  // Floor the picker at "now" so an admin can't schedule a send in the PAST
  // (ambiguous — depending on server handling it might fire immediately, never,
  // or error). Native `min` greys out earlier slots and flags a typed-in past
  // value as invalid.
  const minLocal = toLocalInput(new Date().toISOString());

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex bg-muted rounded-lg p-0.5 text-xs">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange("now")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition ${
            mode === "now" ? "bg-card shadow-sm font-semibold" : "text-muted-foreground"
          }`}
        >
          <SendHorizontal size={12} />
          Send now
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onModeChange("schedule")}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition ${
            mode === "schedule" ? "bg-card shadow-sm font-semibold" : "text-muted-foreground"
          }`}
        >
          <CalendarClock size={12} />
          Schedule
        </button>
      </div>
      {mode === "schedule" && (
        <input
          type="datetime-local"
          value={localValue}
          min={minLocal}
          disabled={disabled}
          onChange={(e) =>
            onScheduledAtChange(e.target.value ? fromLocalInput(e.target.value) : null)
          }
          className="px-3 py-1.5 rounded-lg border border-border bg-card text-xs focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      )}
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString();
}
