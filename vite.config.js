import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api to FastAPI so the browser never deals with CORS or ports.
export default defineConfig({
  plugins: [react()],
  publicDir: "src/public",
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" } },
});