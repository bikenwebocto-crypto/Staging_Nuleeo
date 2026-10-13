// Profile-edit form (avatar + name/phone/address). Used both by the standalone
// /profile/settings page and as a sub-view inside ProfileDrawer. The host owns
// chrome (page header vs drawer header) and decides what to do after save via
// the optional onSaved callback.

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { useAuth } from "@ui/lib/useAuth";
import { apiRequest } from "@ui/lib/queryClient";
import { useToast } from "@ui/hooks/use-toast";
import { AvatarUploader } from "@ui/components/common/AvatarUploader";

interface Props {
  // Called after a successful save. If omitted, the form does nothing — the
  // host is expected to react to the profile refresh or rely on the toast.
  onSaved?: () => void;
}

export function ProfileSettingsForm({ onSaved }: Props) {
  const { profile, refreshProfile } = useAuth();
  const { toast } = useToast();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);

  // Hydrate from the live profile. In an effect so we re-sync when the
  // profile loads asynchronously (e.g. on first mount).
  useEffect(() => {
    setFirstName(profile?.firstName ?? "");
    setLastName(profile?.lastName ?? "");
    setPhone(profile?.phone ?? "");
    setAddress(profile?.address ?? "");
  }, [profile]);

  const initial = (profile?.firstName?.[0] ?? profile?.email?.[0] ?? "?").toUpperCase();

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await apiRequest("PATCH", "/api/profile", {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        address: address.trim(),
      });
      await refreshProfile();
      toast({ title: "Profile updated" });
      onSaved?.();
    } catch (err) {
      toast({
        title: "Could not save",
        description: (err as Error)?.message ?? "Try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md mx-auto px-5 pb-10">
      <div className="flex flex-col items-center mb-8">
        <AvatarUploader fallbackInitial={initial} size={96} />
      </div>

      <form onSubmit={handleSave} className="space-y-4">
        <div className="bg-card p-5 rounded-2xl shadow-sm space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-bold text-muted-foreground uppercase ml-1">
              First Name
            </label>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-muted-foreground uppercase ml-1">
              Last Name
            </label>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-muted-foreground uppercase ml-1">Email</label>
            <input
              type="email"
              value={profile?.email ?? ""}
              readOnly
              disabled
              className="w-full bg-muted border border-border rounded-xl px-4 py-3 text-muted-foreground font-medium cursor-not-allowed"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-muted-foreground uppercase ml-1">Phone</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-bold text-muted-foreground uppercase ml-1">
              Address
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full bg-background border border-border rounded-xl px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition font-medium"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full bg-primary text-primary-foreground font-bold py-4 rounded-xl shadow-lg shadow-gray-900/20 active:scale-[0.98] transition hover:bg-primary/90 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={18} className="animate-spin" /> : <Save size={18} />}
          {saving ? "Saving…" : "Save Changes"}
        </button>
      </form>
    </div>
  );
}
