import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, rollupOptions: { output: { manualChunks: (id: string) => id.includes("node_modules") ? (id.includes("/yaml/") ? "yaml" : "ui-runtime") : undefined } } },
  server: { host: "127.0.0.1", proxy: { "/dashboards": { target: "http://127.0.0.1:8127", changeOrigin: true } } },
});
