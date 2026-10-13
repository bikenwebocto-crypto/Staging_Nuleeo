// Downloads the owner briefing as a real PDF file. We can't ask the
// browser to "save as PDF" without showing the print dialog, so we
// rasterize the server-rendered HTML into a PDF on the client and
// trigger a normal file download.
//
// Flow:
//   1. Fetch briefing HTML from the server (auth'd, plan-gated).
//   2. Mount it in a hidden, A4-sized iframe so its styles don't leak
//      and html2canvas captures the layout at the right dimensions.
//   3. Wait for images and fonts inside the iframe to settle.
//   4. Lazy-load html2pdf.js (~kb-heavy lib, only paid when used).
//   5. Convert the iframe's `.page` element to a single-page A4 PDF
//      and save it via the browser's normal download path.

import { apiRequest, parseApiError } from "./queryClient";

export interface OpenBriefingResult {
  ok: boolean;
  error?: string;
}

export async function openBriefing(
  scope: "portfolio" | { propertyId: string },
  // Active-portfolio scope. When the owner has switched into a portfolio they
  // were granted access to, we tag the request with `?portfolioId=<stable
  // portfolio doc id>` (preferred) — or the legacy `?ownerId=<uid>` while the
  // doc id is still resolving — so the server renders that portfolio (and
  // gates on its plan). Omitted / isSelf → the caller's own portfolio, no
  // query param.
  owner?: { ownerId: string; isSelf: boolean; portfolioDocId?: string | null },
): Promise<OpenBriefingResult> {
  const base =
    scope === "portfolio"
      ? "/api/owner/briefing"
      : `/api/owner/briefing?propertyId=${encodeURIComponent(scope.propertyId)}`;
  const sep = base.includes("?") ? "&" : "?";
  let url = base;
  if (owner && !owner.isSelf) {
    if (owner.portfolioDocId) {
      url = `${base}${sep}portfolioId=${encodeURIComponent(owner.portfolioDocId)}`;
    } else if (owner.ownerId) {
      url = `${base}${sep}ownerId=${encodeURIComponent(owner.ownerId)}`;
    }
  }

  let iframe: HTMLIFrameElement | null = null;
  try {
    const res = await apiRequest("GET", url);
    const html = await res.text();

    iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.position = "fixed";
    iframe.style.left = "-10000px";
    iframe.style.top = "0";
    iframe.style.width = "210mm";
    iframe.style.height = "297mm";
    iframe.style.border = "0";
    iframe.style.opacity = "0";
    iframe.style.pointerEvents = "none";
    document.body.appendChild(iframe);

    const idoc = iframe.contentDocument;
    if (!idoc) throw new Error("Could not open briefing frame");
    idoc.open();
    idoc.write(html);
    idoc.close();

    await waitForFrameReady(iframe);
    await waitForImages(idoc);
    if (idoc.fonts && typeof idoc.fonts.ready?.then === "function") {
      try {
        await idoc.fonts.ready;
      } catch {
        // Font loading is best-effort; proceed anyway.
      }
    }

    const target = idoc.querySelector(".page") as HTMLElement | null;
    if (!target) throw new Error("Briefing markup is missing");

    const html2pdfMod: any = await import("html2pdf.js");
    const html2pdf = html2pdfMod.default ?? html2pdfMod;

    const filename =
      scope === "portfolio"
        ? `olio-portfolio-briefing-${todayStamp()}.pdf`
        : `olio-property-briefing-${todayStamp()}.pdf`;

    await html2pdf()
      .set({
        margin: 0,
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
          logging: false,
        },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
        // The portfolio briefing can run past one A4 page. Tell html2pdf to
        // shift page breaks so they never cut through a table row, a card,
        // a stat tile, or a section — keeps multi-page output clean.
        pagebreak: {
          mode: ["css", "legacy"],
          avoid: ["tr", ".card", ".stat", ".fig", ".section"],
        },
      })
      .from(target)
      .save();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: parseApiError(err, "Failed to load briefing") };
  } finally {
    if (iframe && iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  }
}

function waitForFrameReady(iframe: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve) => {
    const doc = iframe.contentDocument;
    if (doc && doc.readyState === "complete") return resolve();
    const t = setTimeout(() => resolve(), 4000);
    iframe.addEventListener(
      "load",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function waitForImages(doc: Document): Promise<void> {
  const imgs = Array.from(doc.images);
  return Promise.all(
    imgs.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) return resolve();
          const done = () => resolve();
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
        }),
    ),
  ).then(() => undefined);
}

function todayStamp(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
