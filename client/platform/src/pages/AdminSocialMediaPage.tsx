import { useEffect, useState } from "react";
import { PAGE_CONTAINER_CLASSNAME } from "@/components/common/AdminLayout";
import { ExternalLink, Save, Pencil } from "lucide-react";
import { useToast } from "@ui/hooks/use-toast";
import {
  SOCIAL_PLATFORM_KEYS,
  SOCIAL_PLATFORM_META,
  type SocialPlatformKey,
} from "@shared/firestore-schema";
import { SOCIAL_ICONS } from "@ui/components/SocialIcons";
import { useSocialLinks, saveSocialLinks } from "@ui/lib/socialStore";
import { usePrivileges } from "@ui/lib/usePrivileges";
import { ForbiddenView } from "@ui/components/ForbiddenView";

export default function AdminSocialMediaPage() {
  const { canPlatform } = usePrivileges();
  const { links } = useSocialLinks();
  const [drafts, setDrafts] = useState<Record<SocialPlatformKey, string>>(
    () =>
      ({
        ...links,
      }) as Record<SocialPlatformKey, string>,
  );
  const [editingKey, setEditingKey] = useState<SocialPlatformKey | null>(null);
  const [savingKey, setSavingKey] = useState<SocialPlatformKey | null>(null);
  const { toast } = useToast();

  // Keep local draft state in sync with Firestore for any platform the user
  // is NOT currently editing — so realtime updates from other admins land
  // but mid-edit text isn't clobbered.
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const k of SOCIAL_PLATFORM_KEYS) {
        if (editingKey !== k) next[k] = links[k] ?? "";
      }
      return next;
    });
  }, [links, editingKey]);

  const handleSave = async (key: SocialPlatformKey) => {
    setSavingKey(key);
    try {
      await saveSocialLinks({ [key]: drafts[key] ?? "" });
      setEditingKey(null);
      toast({
        title: "Link saved",
        description: `${SOCIAL_PLATFORM_META[key].label} link has been updated.`,
      });
    } catch (err: any) {
      toast({
        title: "Save failed",
        description: err?.message ?? "Could not save the link.",
        variant: "destructive",
      });
    } finally {
      setSavingKey(null);
    }
  };

  if (!canPlatform("comm.email")) {
    return (
      <div className={PAGE_CONTAINER_CLASSNAME}>
        <ForbiddenView
          title="Social media locked"
          message="Your platform role doesn't include the 'Manage email marketing' privilege (used for social links too). An admin can grant it in Settings → Platform Roles."
        />
      </div>
    );
  }

  return (
    <div className={PAGE_CONTAINER_CLASSNAME}>
      <div className="mb-8 md:mb-2 mt-4 md:mt-0">
        <div className="md:hidden">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Social Media</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Connect platform-wide social accounts
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Enter the URL for each platform to connect your social accounts. Saved links appear
        instantly on the landing footer and in the app sidebar.
      </p>

      <div className="space-y-3">
        {SOCIAL_PLATFORM_KEYS.map((key) => {
          const meta = SOCIAL_PLATFORM_META[key];
          const { Icon, accent } = SOCIAL_ICONS[key];
          const isEditing = editingKey === key;
          const draftValue = drafts[key] ?? "";
          const liveValue = links[key] ?? "";
          const isConnected = liveValue.trim().length > 0;
          const isSaving = savingKey === key;

          return (
            <div
              key={key}
              className="bg-card border border-border rounded-xl px-5 py-4 transition hover:border-primary/20"
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-secondary/60 flex items-center justify-center shrink-0">
                  <Icon className={`w-[18px] h-[18px] ${accent}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-foreground">{meta.label}</span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${isConnected ? "bg-green-500" : "bg-muted-foreground/30"}`}
                    />
                  </div>

                  {isEditing ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="url"
                        value={draftValue}
                        onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                        placeholder={meta.placeholder}
                        autoFocus
                        disabled={isSaving}
                        className="flex-1 bg-background border border-input rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSave(key);
                          if (e.key === "Escape") {
                            setEditingKey(null);
                            setDrafts((prev) => ({ ...prev, [key]: liveValue }));
                          }
                        }}
                      />
                      <button
                        onClick={() => handleSave(key)}
                        disabled={isSaving}
                        className="flex items-center gap-1.5 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition shrink-0 disabled:opacity-60"
                      >
                        <Save size={14} />
                        {isSaving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  ) : isConnected ? (
                    <p className="text-xs text-muted-foreground truncate">{liveValue}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground/40">No link added</p>
                  )}
                </div>

                {!isEditing && (
                  <div className="flex items-center gap-0.5 shrink-0">
                    {isConnected && (
                      <a
                        href={liveValue}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition"
                        title="Open link"
                      >
                        <ExternalLink size={15} />
                      </a>
                    )}
                    <button
                      onClick={() => {
                        setDrafts((prev) => ({ ...prev, [key]: liveValue }));
                        setEditingKey(key);
                      }}
                      className="p-2 rounded-lg hover:bg-secondary text-muted-foreground hover:text-foreground transition"
                      title="Edit link"
                    >
                      <Pencil size={15} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
