import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const distPath = join(packageRoot, "dist");

// A clean output directory keeps stale JavaScript or declarations out of a pack.
rmSync(distPath, { recursive: true, force: true });

const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
const result = spawnSync(tsc, ["--project", join(packageRoot, "tsconfig.build.json")], {
  cwd: packageRoot,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
