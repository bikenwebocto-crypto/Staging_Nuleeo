import { ReactNode } from "react";
import { cn } from "@ui/lib/utils";

// A single source of truth for status chips. Use INTENT, not color — the
// component maps to the semantic status tokens (success/warning/destructive/
// info), each of which carries its own .dark pairing, so chips stay legible in
// both light and dark mode automatically.
//
//   <StatusPill intent="success">Active</StatusPill>
//   <StatusPill intent="warning" size="sm">Pending</StatusPill>
//
// If you find yourself reaching for `tone="..."` className overrides in
// the wild, prefer this. It keeps semantics + accessibility consistent.

export type StatusIntent = "success" | "warning" | "danger" | "info" | "neutral";
export type StatusSize = "sm" | "md";

const INTENT_STYLES: Record<StatusIntent, string> = {
  success: "bg-success/10 text-success border-success/20",
  warning: "bg-warning/10 text-warning border-warning/20",
  danger: "bg-destructive/10 text-destructive border-destructive/20",
  info: "bg-info/10 text-info border-info/20",
  neutral: "bg-secondary text-muted-foreground border-border",
};

const SIZE_STYLES: Record<StatusSize, string> = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2.5 py-1 text-xs",
};

interface StatusPillProps {
  intent: StatusIntent;
  size?: StatusSize;
  className?: string;
  children: ReactNode;
}

export function StatusPill({ intent, size = "md", className, children }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-semibold border whitespace-nowrap",
        INTENT_STYLES[intent],
        SIZE_STYLES[size],
        className,
      )}
    >
      {children}
    </span>
  );
}
