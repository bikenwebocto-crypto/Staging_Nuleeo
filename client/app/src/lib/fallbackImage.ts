import aptExterior from "@/assets/images/apt-exterior.jpg";
import aptInterior from "@/assets/images/apt-interior.jpg";

// Decorative stock photos shown when a unit / agreement / activity carries no
// real photo of its own. Used by the tenant dashboard, the tenant agreements
// page and the notifications panel — where a missing image should read as a
// pretty placeholder rather than an empty box.
//
// `pickFallbackImage` is deterministic in its seed (an entity id), so the same
// lease/unit always lands on the same picture — across re-renders and across
// the three surfaces. (Owner-facing surfaces use the neutral <PropertyImage>
// building glyph instead; this stock-photo fallback is a tenant-side choice.)
const FALLBACK_IMAGES = [aptExterior, aptInterior];

export function pickFallbackImage(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return FALLBACK_IMAGES[Math.abs(hash) % FALLBACK_IMAGES.length];
}
