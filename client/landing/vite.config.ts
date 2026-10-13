import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const here = import.meta.dirname;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: here,
  envDir: path.resolve(here, "..", ".."),
  // Disable PostCSS config discovery — Tailwind v4 runs through the Vite plugin above.
  // The root postcss.config.js would otherwise try to load `tailwindcss` as a PostCSS plugin and error.
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      "@": path.resolve(here, "src"),
      "@ui": path.resolve(here, "..", "shared"),
      "@shared": path.resolve(here, "..", "..", "shared"),
    },
  },
  build: {
    outDir: path.resolve(here, "..", "..", "dist", "landing"),
    emptyOutDir: true,
  },
  server: {
    port: 5101,
    host: "localhost",
  },
});
