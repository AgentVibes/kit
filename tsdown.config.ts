import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/resource/index.ts",
    "src/react/index.ts",
    "src/diagnostics/index.ts",
    "src/cn/index.ts",
  ],
  outDir: "dist",
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "neutral",
  // Keep the shared modules (diagnostics, resource) in one chunk instead of
  // inlining a copy into every entry — two copies of the diagnostics dedup set
  // would make resetDiagnostics() only clear one of them.
  unbundle: true,
});
