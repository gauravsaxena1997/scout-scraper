import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  shims: true,
  target: "node18",
  external: ["apify-client", "@modelcontextprotocol/sdk"],
});
