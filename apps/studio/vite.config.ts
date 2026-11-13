import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Where `pnpm dev` runs the api. */
const API_URL = process.env["STUDIO_API_URL"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Evergreen browsers only, matching Tailwind 4's own floor, raised to Chrome 120 for :dir().
    // Vite's default CSS target rewrites :dir(rtl) as :lang(ar…), which never matches content
    // whose direction comes from dir="auto" (design system §6).
    cssTarget: ["chrome120", "edge120", "firefox128", "safari16.4"],
  },
  // The Studio calls the api on its own origin, so the session cookie is first-party and the
  // browser's Origin header is the Studio's (task 1.2). Production puts both behind one host.
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/v1": API_URL } },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy: { "/v1": API_URL } },
});
