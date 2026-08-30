import { chmodSync, existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

for (const [name, path] of Object.entries(pkg.bin ?? {})) {
  const target = resolve(root, path);
  // A bin can be declared before its source exists; warn rather than breaking
  // `npm install`, which runs this through the prepare script.
  if (!existsSync(target)) {
    console.warn(`chmod-bins: skipping ${name} — ${path} was not built`);
    continue;
  }
  chmodSync(target, 0o755);
}
