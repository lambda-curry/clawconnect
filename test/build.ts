import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function build() {
  // Rebuild before test imports so artifact-based checks cannot exercise stale code.
  execFileSync("pnpm", ["exec", "vp", "run", "-r", "--no-cache", "build"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
  });
}
