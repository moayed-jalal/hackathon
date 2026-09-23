import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/auth": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
});
