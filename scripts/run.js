import { spawn } from "node:child_process";

const [mode, name] = process.argv.slice(2);

if (!mode || !name) {
  console.error("Usage: node scripts/run.js <dev|start> <server-name>");
  process.exit(1);
}

const cmd =
  mode === "dev"
    ? ["tsx", `src/servers/${name}.ts`]
    : ["node", `dist/servers/${name}.js`];

spawn("npx", cmd, { stdio: "inherit" }).on("exit", (code) =>
  process.exit(code ?? 0),
);
