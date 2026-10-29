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
      // Base UI subscribes to its stores through React's use-sync-external-store
      // shims, which are CommonJS and require("react") directly. The preset's
      // react -> preact/compat alias does not reach into a require, so they would
      // load React itself; these ESM stand-ins use preact/compat instead.
      {
        find: /^use-sync-external-store\/shim\/with-selector(\.js)?$/,
        replacement: src("lib/shims/use-sync-external-store-with-selector.ts"),
      },
      {
        find: /^use-sync-external-store\/shim(\/index)?(\.js)?$/,
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
        // Vitest loads dependencies from node_modules without Vite's resolver, so
        // Base UI and Floating UI would import React itself and break on Preact's
        // hooks. Inlining them routes their imports through the aliases above.
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
