import { useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";

// Unmatched platform routes redirect home. Anonymous → /login (handled by
// RequireAuth on /); signed-in admins land on the SuperAdminDashboard.
// Non-admin signed-in users get punted to /login as well, matching the
// rest of the admin shell's gating model.
export default function NotFound() {
  const { loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (loading) return;
    setLocation("/");
  }, [loading, setLocation]);

  return (
    <div className="min-h-[60vh] w-full flex flex-col items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Redirecting" />
      <p className="mt-3 text-sm">Taking you home…</p>
    </div>
  );
}
