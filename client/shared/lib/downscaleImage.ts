// Shrink a user-picked photo in the browser BEFORE upload. A typical
// 8–10 MB phone photo (e.g. 4032×3024) becomes a ~1920px JPEG of a few
// hundred KB — the same picture, ~30× fewer bytes — so property and
// listing photos load fast in lists, cards and heroes without any
// server-side resize pipeline (no sharp, no Firebase extension).
//
// Safe by construction: it returns the ORIGINAL file untouched when the
// photo is already small, isn't a decodable raster (e.g. SVG), the
// browser lacks the canvas APIs, or anything in the resize path throws.
// It can only make an upload smaller — never break it or make it larger.

export interface DownscaleOptions {
  /** Longest edge, in pixels, of the output. Default 1920. */
  maxEdge?: number;
  /** JPEG quality, 0–1. Default 0.82. */
  quality?: number;
}

const DEFAULT_MAX_EDGE = 1920;
const DEFAULT_QUALITY = 0.82;
// Below this, a re-encode rarely pays for itself — leave the file alone.
const SKIP_BELOW_BYTES = 1024 * 1024; // 1 MB

interface DecodedImage {
  source: CanvasImageSource;
  width: number;
  height: number;
  close(): void;
}

export async function downscaleImage(
  file: File,
  { maxEdge = DEFAULT_MAX_EDGE, quality = DEFAULT_QUALITY }: DownscaleOptions = {},
): Promise<File> {
  // Non-raster (SVG) inputs can't be drawn to a canvas meaningfully.
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") {
    return file;
  }

  let decoded: DecodedImage | null = null;
  try {
    decoded = await decode(file);
    const { source, width, height } = decoded;
    const longest = Math.max(width, height);

    // Already within budget AND small on disk → nothing to gain.
    if (longest <= maxEdge && file.size <= SKIP_BELOW_BYTES) {
      return file;
    }

    const scale = longest > maxEdge ? maxEdge / longest : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;

    // JPEG has no alpha channel — paint white first so any transparency
    // (e.g. a PNG) flattens to white rather than black.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(source, 0, 0, w, h);

    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    // Re-encode didn't help (already-optimised input) → keep the original.
    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    // Any decode/encode failure falls back to the untouched original.
    return file;
  } finally {
    decoded?.close();
  }
}

// Decode to something drawable. Prefer createImageBitmap with
// `imageOrientation: "from-image"` so EXIF rotation is baked in (portrait
// phone photos don't come out sideways); fall back to a plain bitmap, then
// to an <img> element on engines that lack/limit createImageBitmap.
async function decode(file: File): Promise<DecodedImage> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      try {
        const bmp = await createImageBitmap(file);
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      } catch {
        // fall through to <img>
      }
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("image decode failed"));
      el.src = url;
    });
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
