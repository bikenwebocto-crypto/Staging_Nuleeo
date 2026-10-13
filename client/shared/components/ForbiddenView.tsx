// Rendered when a signed-in user lacks the privilege required for a page.
// Sidebar entries are already hidden by `canPlatform()`, but a user who has
// the URL bookmarked (or had the privilege revoked mid-session) lands here.

import { ShieldOff } from "lucide-react";

export interface ForbiddenViewProps {
  title?: string;
  message?: string;
}

export function ForbiddenView({
  title = "Access restricted",
  message = "You don't have permission to view this page. If you think this is a mistake, ask an administrator to grant the matching privilege.",
}: ForbiddenViewProps) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-8">
      <div className="bg-card rounded-xl border border-border shadow-sm max-w-md w-full p-8 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-warning/10 text-warning mb-4">
          <ShieldOff size={20} />
        </div>
        <h1 className="text-base font-semibold text-foreground mb-2">{title}</h1>
        <p className="text-sm text-muted-foreground leading-relaxed">{message}</p>
      </div>
    </div>
  );
}
