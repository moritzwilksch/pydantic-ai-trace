import preact from "@preact/preset-vite";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Single-file output: the one index.html is both what the server serves at /
// and the template `paitrace export` injects trace data into.
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  build: {
    outDir: "../src/pydantic_ai_trace/static",
    emptyOutDir: true,
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
