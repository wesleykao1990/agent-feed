import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const npmTypeScript = process.platform === "win32" ? "tsc.cmd" : "tsc";
await rm("dist", { recursive: true, force: true });
execFileSync(npmTypeScript, ["-p", "tsconfig.build.json"], { stdio: "inherit" });

async function rewriteDeclarationImports(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const pathname = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarationImports(pathname);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const source = await readFile(pathname, "utf8");
    const rewritten = source.replace(/\.ts(?=["'])/gu, ".js");
    if (rewritten !== source) await writeFile(pathname, rewritten, "utf8");
  }
}

await rewriteDeclarationImports("dist");
