import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      // allow importing ../convex/_generated from outside the web root
      allow: [".."],
    },
  },
});
