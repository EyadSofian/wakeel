import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Evergreen browsers only, matching Tailwind 4's own floor, raised to Chrome 120 for :dir().
    // Vite's default CSS target rewrites :dir(rtl) as :lang(ar…), which never matches content
    // whose direction comes from dir="auto" (design system §6).
    cssTarget: ["chrome120", "edge120", "firefox128", "safari16.4"],
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
