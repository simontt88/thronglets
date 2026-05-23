import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig(({ mode }) => ({
  plugins: mode === "singlefile"
    ? [react(), viteSingleFile()]
    : [react()],
  build: {
    outDir: mode === "singlefile" ? "dist-single" : "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3847",
      "/ws": { target: "ws://127.0.0.1:3847", ws: true },
    },
  },
}));
