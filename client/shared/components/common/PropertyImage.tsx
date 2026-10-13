import { useState } from "react";
import { Building, type LucideIcon } from "lucide-react";
import { cn } from "@ui/lib/utils";

// Property/listing thumbnail that degrades to a Building glyph when the
// photo is MISSING **or** FAILS TO LOAD — so a property with no photo (or a
// dead URL) reads as "no image" instead of an empty grey box. Same
// missing-OR-errored fallback contract as <Avatar>; replaces the older
// `<img onError={hide}>` pattern that left a blank `bg-secondary` square.
//
// The PARENT controls size, rounding and the `bg-secondary` backdrop —
// this component just fills it with either the photo or the centred icon.
//
//   <div className="w-16 h-12 rounded-lg overflow-hidden bg-secondary">
//     <PropertyImage src={property.image} alt={property.address} iconSize={18} />
//   </div>

interface PropertyImageProps {
  src?: string | null;
  alt?: string | null;
  // Applied to the <img> (e.g. hover/zoom transitions).
  className?: string;
  // Fallback glyph. Defaults to Building; marketplace listings pass Home.
  icon?: LucideIcon;
  // Fallback-icon size. Match it to the box.
  iconSize?: number;
  // Applied to the fallback wrapper.
  fallbackClassName?: string;
}

export function PropertyImage({
  src,
  alt,
  className,
  icon: Icon = Building,
  iconSize = 20,
  fallbackClassName,
}: PropertyImageProps) {
  const [errored, setErrored] = useState(false);
  const showImage = !!src && !errored;

  if (showImage) {
    return (
      <img
        src={src!}
        alt={alt ?? "Property"}
        onError={() => setErrored(true)}
        // PERF: defer off-screen image loads (lists/grids) + async decode so
        // image fetch/decode never blocks the main thread on scroll.
        loading="lazy"
        decoding="async"
        className={cn("w-full h-full object-cover", className)}
      />
    );
  }

  return (
    <div
      className={cn(
        "w-full h-full flex items-center justify-center text-muted-foreground",
        fallbackClassName,
      )}
    >
      <Icon size={iconSize} className="opacity-40" />
    </div>
  );
}
