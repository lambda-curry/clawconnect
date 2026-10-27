import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    // Docs, design notes, and the hand-authored widget shell are kept as written.
    ignorePatterns: ["docs/**", "**/*.md", "apps/chatgpt/src/widget/shell.html"],
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  run: {
    cache: true,
  },
  test: {
    globalSetup: ["./test/build.ts"],
  },
});
