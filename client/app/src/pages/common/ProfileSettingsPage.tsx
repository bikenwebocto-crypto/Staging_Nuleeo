import { useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { useHideMobileHeader } from "@/components/common/AppLayout";
import { ProfileSettingsForm } from "@ui/components/common/ProfileSettingsForm";

export default function ProfileSettingsPage() {
  const [, setLocation] = useLocation();
  useHideMobileHeader();

  const goBack = () => {
    if (window.history.length > 1) window.history.back();
    else setLocation("/owner");
  };

  return (
    <>
      {/* Mobile Header */}
      <div className="md:hidden bg-card pt-6 px-5 flex items-center justify-between mb-8 sticky top-0 z-10 shadow-sm pb-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Back"
            onClick={goBack}
            className="w-10 h-10 bg-secondary rounded-full flex items-center justify-center hover:bg-secondary transition"
          >
            <ArrowLeft size={20} className="text-foreground" />
          </button>
          <h1 className="text-xl font-bold text-foreground">Profile Settings</h1>
        </div>
      </div>

      {/* Clear the floating mobile nav (see PAGE_CONTAINER_CLASSNAME note). The
          shared form is also rendered inside the z-60 ProfileDrawer, which sits
          above the nav and needs no clearance — so it's reserved here, not in
          the form itself. */}
      <div className="pb-[var(--mobile-nav-clearance)] md:pb-0">
        <ProfileSettingsForm onSaved={goBack} />
      </div>
    </>
  );
}
