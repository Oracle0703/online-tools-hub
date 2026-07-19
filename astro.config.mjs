import { defineConfig } from "astro/config";
import react from "@astrojs/react";

export default defineConfig({
  site: "https://oracle0703.github.io",
  base: "/online-tools-hub",
  output: "static",
  trailingSlash: "always",
  integrations: [react()],
  markdown: {
    syntaxHighlight: false,
  },
  security: {
    csp: {
      directives: [
        "default-src 'self'",
        "base-uri 'self'",
        "connect-src 'none'",
        "font-src 'self'",
        "form-action 'none'",
        "frame-src 'none'",
        "img-src 'self' data: blob:",
        "manifest-src 'self'",
        "media-src 'none'",
        "object-src 'none'",
        "worker-src 'self'",
      ],
    },
  },
  build: {
    assets: "assets",
  },
});
