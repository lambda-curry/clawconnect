import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: {
      tsgo: true,
    },
    // Name the binary explicitly — see the note in packages/mcp/vite.config.ts:
    // auto-detect derives it from the package name (@clawconnect/cli -> "cli")
    // and rewrites package.json's `bin` on every build.
    exports: { bin: { clawconnect: "./src/bin.ts" } },
    entry: {
      index: "src/index.ts",
      bin: "src/bin.ts",
    },
    deps: { alwaysBundle: ["@clawconnect/core"] },
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
