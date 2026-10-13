import { Camera, Loader2, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { uploadAvatar, ALLOWED_AVATAR_TYPES } from "@ui/lib/uploadAvatar";
import { useAuth } from "@ui/lib/useAuth";

type Props = {
  fallbackInitial: string;
  size?: number;
};

export function AvatarUploader({ fallbackInitial, size = 64 }: Props) {
  const { profile, refreshProfile } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Remembers an avatar URL that failed to load (e.g. a stale Google photo
  // URL) so we render the initial instead of a broken-image icon. Keyed on
  // the URL, so the freshly uploaded photo is retried automatically.
  const [photoFailedSrc, setPhotoFailedSrc] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      await uploadAvatar(file);
      await refreshProfile();
    } catch (err: any) {
      setError(err?.message ?? "Could not update photo");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
        style={{ width: size, height: size }}
        className="group relative rounded-full border-2 border-background shrink-0 bg-primary text-primary-foreground flex items-center justify-center font-bold text-lg cursor-pointer disabled:cursor-wait"
        aria-label="Change profile photo"
      >
        <span className="absolute inset-0 rounded-full overflow-hidden flex items-center justify-center">
          {profile?.photoURL && profile.photoURL !== photoFailedSrc ? (
            <img
              src={profile.photoURL}
              alt="Profile"
              className="w-full h-full object-cover"
              referrerPolicy="no-referrer"
              onError={() => setPhotoFailedSrc(profile?.photoURL ?? null)}
            />
          ) : (
            fallbackInitial
          )}
          <span
            className={`absolute inset-0 flex items-center justify-center bg-black/55 text-white transition-opacity ${
              busy ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Camera size={18} />}
          </span>
        </span>
        {/* Always-visible edit badge so the affordance is discoverable without hovering. */}
        <span className="absolute -bottom-0.5 -right-0.5 w-6 h-6 rounded-full bg-foreground text-background border-2 border-card flex items-center justify-center shadow">
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Pencil size={11} />}
        </span>
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_AVATAR_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
