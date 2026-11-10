import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { developmentCspHtml } from "./scripts/dev-csp";

export default defineConfig({
  base: "./",
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "@base-ui/react/dialog",
      "@base-ui/react/tabs",
    ],
  },
  plugins: [
    react(),
    {
      name: "development-csp",
      transformIndexHtml(html, ctx) {
        return developmentCspHtml(html, !!ctx.server);
      },
    },
  ],
  server: { host: "127.0.0.1", port: 8070, strictPort: true },
  build: { target: "es2022", sourcemap: true },
});
