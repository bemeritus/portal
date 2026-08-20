import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server owns the browser's origin and forwards the API to Axum, so
// the session cookie is same-origin in development exactly as it is in
// production. Without the proxy the cookie would be cross-site and `SameSite=Lax`
// would drop it — the app would log in and immediately look logged out.
export default defineConfig({
  plugins: [react()],
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
  },
});
