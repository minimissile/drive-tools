import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
        return ctx.server
          ? html.replace(
              "script-src 'self';",
              "script-src 'self' 'unsafe-inline';",
            )
          : html;
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { target: "es2022", sourcemap: true },
});
