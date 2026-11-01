/* The dashboard: built into ../public next to t.js, replay.js and the player, served by Workers Assets. */
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { mockApi } from "./dev-mock";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react(), tailwindcss(), ...(process.env.MOCK ? [mockApi()] : [])],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../public", emptyOutDir: false, assetsDir: "app", sourcemap: false,
    rollupOptions: { output: { manualChunks: (id) => (/node_modules\/(recharts|d3-|victory|es-toolkit|immer|reselect|@reduxjs|react-redux)/.test(id) ? "charts" : /node_modules\/(react|react-dom|scheduler|@base-ui|@floating-ui)\//.test(id) ? "react" : undefined) } },
  },
  server: { port: 5199, proxy: process.env.MOCK ? undefined : { "/api": "http://localhost:8787" } },
});
