import { useEffect } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";
import { usePlan } from "@ui/lib/usePlan";
import { isOwnerExperience } from "@/lib/isOwner";

// Any unmatched route inside the authenticated shell bounces the user back
// to whichever home page matches their primary mode. Mirrors the same
// owner/tenant decision used by HomeRedirect at "/" so a bad link never
// stalls the user on a dead screen.
export default function NotFound() {
  const { firebaseUser, profile, loading } = useAuth();
  const { plan, loading: planLoading } = usePlan();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (loading || planLoading) return;
    if (!firebaseUser) {
      setLocation("/auth");
      return;
    }
    if (!profile) return;
    const isOwner = isOwnerExperience(profile, plan);
    setLocation(isOwner ? "/owner" : "/tenant");
  }, [loading, planLoading, firebaseUser, profile, plan, setLocation]);

  return (
    <div className="min-h-[60vh] w-full flex flex-col items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" aria-label="Redirecting" />
      <p className="mt-3 text-sm">Taking you home…</p>
    </div>
  );
}
