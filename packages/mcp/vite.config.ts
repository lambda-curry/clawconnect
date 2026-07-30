import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    // Name the binary explicitly. Left to auto-detect, `vp pack` derives the
    // command name from the package name without its scope (@clawconnect/mcp
    // -> "mcp") and rewrites package.json's `bin` field on every build, which
    // silently renames the published binary if the change gets committed.
    exports: { bin: { "clawconnect-mcp": "./src/bin.ts" } },
    entry: {
      index: "src/index.ts",
      bin: "src/bin.ts",
    },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
