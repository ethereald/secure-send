import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    target: "es2022",
  },
});
