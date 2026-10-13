import { useState } from "react";
import { cn } from "@ui/lib/utils";

// Identity bubble used in headers, dashboards, drawers, list rows.
// One component, three sizes — replaces hand-rolled <img> + initials
// fallbacks that drifted in radius, border, font weight, and fallback
// color across the codebase.
//
//   <Avatar name="Jane Smith" src={profile.photoURL} size="md" />
//
// `name` is used to compute the initials fallback. Pass `email` if you
// don't have a display name handy and you'd like the first character of
// the email used instead.

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
export type AvatarShape = "circle" | "squircle";

const SIZE_STYLES: Record<AvatarSize, { box: string; font: string }> = {
  xs: { box: "w-7 h-7", font: "text-[10px]" },
  sm: { box: "w-8 h-8", font: "text-xs" },
  md: { box: "w-10 h-10", font: "text-sm" },
  lg: { box: "w-14 h-14", font: "text-lg" },
  xl: { box: "w-24 h-24", font: "text-3xl" },
};

const SHAPE_STYLES: Record<AvatarShape, string> = {
  circle: "rounded-full",
  // Used for institutional / partner / lead identities where rounded-square
  // reads more "logo" than "person".
  squircle: "rounded-xl",
};

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  email?: string | null;
  size?: AvatarSize;
  shape?: AvatarShape;
  className?: string;
  // Override the fallback bubble palette. Defaults to a neutral
  // primary-on-primary/10 look that works in both themes.
  fallbackClassName?: string;
}

function initialsFrom(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    if (parts.length === 1) return parts[0][0].toUpperCase();
  }
  if (email) return email[0]?.toUpperCase() ?? "?";
  return "?";
}

export function Avatar({
  src,
  name,
  email,
  size = "md",
  shape = "circle",
  className,
  fallbackClassName,
}: AvatarProps) {
  const [errored, setErrored] = useState(false);
  const { box, font } = SIZE_STYLES[size];
  const showImage = !!src && !errored;
  const initials = initialsFrom(name, email);

  return (
    <div
      className={cn(
        "overflow-hidden border border-border flex items-center justify-center shrink-0 bg-secondary",
        SHAPE_STYLES[shape],
        box,
        className,
      )}
    >
      {showImage ? (
        <img
          src={src!}
          alt={name ?? email ?? "Avatar"}
          referrerPolicy="no-referrer"
          onError={() => setErrored(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <span
          className={cn(
            "font-semibold w-full h-full flex items-center justify-center bg-primary/10 text-primary",
            font,
            fallbackClassName,
          )}
        >
          {initials}
        </span>
      )}
    </div>
  );
}
