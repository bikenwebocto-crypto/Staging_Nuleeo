// Visual badge for the owner's Stripe Connect status. Discriminated on the
// 6 ConnectStatus kinds — same color/label/icon system wherever Connect
// status needs to appear (Banking page, Settings tab, possible dashboard
// widget). Single source of truth for status visuals.

import { CheckCircle2, Clock, AlertTriangle, Ban, CreditCard, Loader2 } from "lucide-react";
import type { ConnectStatus } from "@ui/lib/useConnectStatus";

interface BadgeStyle {
  label: string;
  iconColor: string;
  bgClass: string;
  borderClass: string;
  textClass: string;
  Icon: typeof CheckCircle2;
}

// The 6 kinds of ConnectStatus are exhaustive; TS narrows fully so the
// fallthrough is unreachable. Explicit cast keeps strict-mode happy.
function styleFor(status: ConnectStatus): BadgeStyle {
  switch (status.kind) {
    case "none":
      return {
        label: "Not connected",
        iconColor: "text-muted-foreground",
        bgClass: "bg-muted/50",
        borderClass: "border-border",
        textClass: "text-muted-foreground",
        Icon: CreditCard,
      };
    case "incomplete":
      return {
        label: "Setup incomplete",
        iconColor: "text-warning",
        bgClass: "bg-warning/10",
        borderClass: "border-warning/30",
        textClass: "text-warning",
        Icon: Loader2,
      };
    case "pendingVerification":
      return {
        label: "Stripe is verifying",
        iconColor: "text-info",
        bgClass: "bg-info/10",
        borderClass: "border-info/30",
        textClass: "text-info",
        Icon: Clock,
      };
    case "active":
      return {
        label: "Active",
        iconColor: "text-success",
        bgClass: "bg-success/10",
        borderClass: "border-success/30",
        textClass: "text-success",
        Icon: CheckCircle2,
      };
    case "actionRequired":
      return {
        label: "Action required",
        iconColor: "text-warning",
        bgClass: "bg-warning/10",
        borderClass: "border-warning/30",
        textClass: "text-warning",
        Icon: AlertTriangle,
      };
    case "restricted":
      return {
        label: "Restricted",
        iconColor: "text-destructive",
        bgClass: "bg-destructive/10",
        borderClass: "border-destructive/30",
        textClass: "text-destructive",
        Icon: Ban,
      };
    default: {
      // Exhaustiveness guard — every ConnectStatus kind handled above.
      const _exhaustive: never = status;
      void _exhaustive;
      return {
        label: "Unknown",
        iconColor: "text-muted-foreground",
        bgClass: "bg-muted",
        borderClass: "border-border",
        textClass: "text-muted-foreground",
        Icon: CreditCard,
      };
    }
  }
}

export function ConnectStatusBadge({ status }: { status: ConnectStatus }) {
  const s = styleFor(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold border ${s.bgClass} ${s.borderClass} ${s.textClass}`}
    >
      <s.Icon size={12} className={s.iconColor} />
      {s.label}
    </span>
  );
}
