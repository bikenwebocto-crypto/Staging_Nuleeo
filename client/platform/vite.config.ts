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
    outDir: path.resolve(here, "..", "..", "dist", "platform"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 800,
    // See client/app/vite.config.ts — "hidden" maps for private symbolication of
    // Cloud Logging client.error stacks; never advertised or deployed publicly.
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
          if (id.includes("/framer-motion/")) return "motion";
          if (id.includes("/lucide-react/")) return "icons";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5103,
    host: "localhost",
    proxy: {
      "/api": "http://localhost:5001",
    },
  },
});
