import { spawnSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stagingRoot = path.join(packageRoot, ".build-src");
const distRoot = path.join(packageRoot, "dist");
const canonicalContracts = path.join(packageRoot, "contracts");
const canonicalTypes = path.resolve(packageRoot, "..", "sdk", "typescript", "generated", "protocol.ts");

await rm(stagingRoot, { recursive: true, force: true });
await rm(distRoot, { recursive: true, force: true });

try {
  await mkdir(path.join(stagingRoot, "generated"), { recursive: true });
  await cp(path.join(packageRoot, "src", "index.ts"), path.join(stagingRoot, "index.ts"));
  await cp(canonicalContracts, path.join(stagingRoot, "contracts"), { recursive: true });
  await cp(canonicalTypes, path.join(stagingRoot, "generated", "protocol.ts"));

  const tsc = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  const result = spawnSync(tsc, ["--project", path.join(packageRoot, "tsconfig.json")], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`TypeScript build failed with exit code ${result.status ?? 1}`);
  }

  // TypeScript emits imports for JSON modules but does not copy the files.
  // Keep the runtime artifact self-contained and byte-identical to the source.
  await cp(path.join(stagingRoot, "contracts"), path.join(distRoot, "contracts"), { recursive: true });
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}
