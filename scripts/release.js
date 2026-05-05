import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

const rl = createInterface({ input, output });
const answer = (await rl.question("Bump type [patch/minor/major]: "))
  .trim()
  .toLowerCase();
rl.close();

if (!["patch", "minor", "major"].includes(answer)) {
  console.error(`Invalid bump type: "${answer}". Expected patch, minor, or major.`);
  process.exit(1);
}

run("npm", ["version", answer]);
run("npm", ["publish"]);

// Publish already succeeded — don't fail the script if push fails (e.g. no remote configured).
const push = spawnSync("git", ["push", "--follow-tags"], { stdio: "inherit" });
if (push.status !== 0) {
  console.warn(
    "\nWarning: `git push --follow-tags` failed. The release was published; push the commit and tag manually.",
  );
}

console.log(`\n✓ Published ${answer} release.`);
