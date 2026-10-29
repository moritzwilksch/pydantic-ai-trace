/// <reference types="vitest/config" />
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// Single-file output: the one index.html is both what the server serves at /
// and the template `paitrace export` injects trace data into.
export default defineConfig({
  plugins: [preact(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: [
      { find: /^@\//, replacement: src("") },
      // Base UI imports React's use-sync-external-store shims, CommonJS files that
      // require("react"). The build resolves that to preact/compat, but Vitest runs
      // them from node_modules, where it would load React itself; see
      // `test.server.deps.inline`. This ESM stand-in uses preact/compat everywhere.
      {
        find: /^use-sync-external-store\/shim(\/index|\/with-selector)?(\.js)?$/,
        replacement: src("lib/shims/use-sync-external-store.ts"),
      },
    ],
  },
  build: {
    outDir: "../src/pydantic_ai_trace/static",
    emptyOutDir: true,
  },
  test: {
    // Tests that assert visibility read the real stylesheet.
    css: { include: [/index\.css/] },
    server: {
      deps: {
        // Routes Base UI's and Floating UI's imports through the aliases above.
        inline: [/@base-ui\//, /@floating-ui\//],
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:1205",
        changeOrigin: true,
      },
    },
  },
});
