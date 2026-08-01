import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: true,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/predictor": "http://127.0.0.1:8000",
    },
  },
});
