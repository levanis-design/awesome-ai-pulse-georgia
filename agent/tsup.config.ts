import { defineConfig } from "tsup";

// The gateway ships as one self-contained ESM file: the MCP SDK and zod are
// bundled in, so the runtime image needs no node_modules (see Dockerfile).
export default defineConfig({
  entry: { gateway: "src/serve.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/./],
  // bundled CommonJS dependencies call require(); an ESM file has to provide one
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
