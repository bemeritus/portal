import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev server owns the browser's origin and forwards the API to Axum, so
// the session cookie is same-origin in development exactly as it is in
// production. Without the proxy the cookie would be cross-site and `SameSite=Lax`
// would drop it — the app would log in and immediately look logged out.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
      // Uploaded images are behind the same session; proxy them too so an
      // <img src="/uploads/…"> works in development.
      "/uploads": {
        target: "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    },
  },
  build: {
    // Read by the backend's STATIC_DIR in production. Kept inside the frontend
    // so `npm run build` never writes outside its own directory.
    outDir: "dist",
    sourcemap: true,
    // three.js's core is ~580 kB minified (145 kB gzip) and cannot be split
    // further; it loads only with the server room. Everything else is far
    // below this.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Libraries in chunks of their own: they change far less often than
        // the app, so browsers keep them cached across releases. three.js's
        // core goes to "three" (server room only); its examples (ambient
        // occlusion) stay with the code that loads them on demand.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("/node_modules/three/build/")) return "three";
          if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom)\//.test(id)) return "react";
          if (/\/node_modules\/(@radix-ui|radix-ui|cmdk|lucide-react|@floating-ui)\//.test(id)) return "ui";
          if (/\/node_modules\/(i18next|react-i18next|@tanstack)\//.test(id)) return "data";
          return undefined;
        },
      },
    },
  },
});
