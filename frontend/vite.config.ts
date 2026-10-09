import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The Rust server is a separate process on a separate port. Everything
 * under /api is proxied to it so the browser sees one origin and the
 * client never carries an absolute URL.
 *
 * Override the target with VITE_API_TARGET when the server runs elsewhere.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
