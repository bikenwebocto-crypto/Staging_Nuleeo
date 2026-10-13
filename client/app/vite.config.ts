import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const here = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: here,
  envDir: path.resolve(here, "..", ".."),
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@": path.resolve(here, "src"),
      "@ui": path.resolve(here, "..", "shared"),
      "@shared": path.resolve(here, "..", "..", "shared"),
    },
  },
  build: {
    outDir: path.resolve(here, "..", "..", "dist", "app"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    // "hidden" emits .map files but DROPS the //# sourceMappingURL comment from
    // the shipped JS — so the maps are never advertised to browsers. The deploy
    // workflow uploads them as a private GitHub artifact (to de-minify the stacks
    // that land in Cloud Logging via reportClientError) and firebase.json's
    // hosting `ignore` keeps **/*.map off public Hosting. See script/symbolicate.ts.
    sourcemap: "hidden",
    modulePreload: false,
    rolldownOptions: {
      output: {
        // Split heavy vendor libs into their own chunks so the main bundle
        // can be cached aggressively while individual deps update independently.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/firebase/") || id.includes("/@firebase/")) return "firebase";
          if (id.includes("/@radix-ui/")) return "radix";
          if (id.includes("/recharts/") || id.includes("/d3-")) return "charts";
          if (
            id.includes("/leaflet/") ||
            id.includes("/react-leaflet/") ||
            id.includes("/react-leaflet-cluster/")
          )
            return "maps";
          // PDF export (html2pdf.js bundles jspdf + html2canvas) is only ever
          // reached via a dynamic import() in briefing.ts, so it already stays
          // out of the entry bundle. Pin it to one chunk so all three heavy
          // transitive deps cache together and update independently.
          if (
            id.includes("/html2pdf.js/") ||
            id.includes("/jspdf/") ||
            id.includes("/html2canvas/")
          )
            return "pdf";
          if (id.includes("/framer-motion/")) return "motion";
          if (id.includes("/embla-carousel")) return "embla";
          if (id.includes("/lucide-react/")) return "icons";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5102,
    host: "localhost",
    proxy: {
      "/api": "http://localhost:5001",
    },
  },
});
