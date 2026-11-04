import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const atlasPort=process.env.VITE_ATLAS_PORT??"18765";
if(!/^\d{1,5}$/.test(atlasPort)||Number(atlasPort)<1||Number(atlasPort)>65535)throw new Error("VITE_ATLAS_PORT must be a local port number");
export default defineConfig({
  plugins: [react()],
  define: { __AEP_BI_PORT__: JSON.stringify(process.env.VITE_AEP_BI_PORT ?? "53583") },
  build: { outDir: "dist", sourcemap: false, rollupOptions: { output: { manualChunks: (id: string) => id.includes("node_modules") ? (id.includes("/three/") ? "three-runtime" : id.includes("/yaml/") ? "yaml" : "ui-runtime") : undefined } } },
  server: { host: "127.0.0.1", proxy: {
    "/dashboards": { target: "http://127.0.0.1:8127", changeOrigin: true },
    // Fixed loopback fixture only; never an arbitrary URL or a bench service.
    "/atlas-api": {target:`http://127.0.0.1:${atlasPort}`,changeOrigin:true,rewrite:path=>path.replace(/^\/atlas-api/, "")},
  } },
});
