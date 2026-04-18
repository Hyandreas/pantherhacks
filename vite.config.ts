import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const securityHeaders = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; "),
};

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { headers: securityHeaders },
  preview: { headers: securityHeaders },
});
