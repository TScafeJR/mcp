#!/usr/bin/env node
/**
 * Dispatcher bin, named to match the package.
 *
 * `npx <pkg> <name>` derives the command from the package name and passes the
 * rest as arguments, so a multi-bin package needs a bin called `mcp` for that
 * form to resolve at all. This is it: `npx @tscafejr/mcp mcp-db` lands here
 * with argv ["mcp-db"], and we hand off to the real server.
 */
const SERVERS: Record<string, () => Promise<unknown>> = {
  visualizer: () => import("./visualizer.js"),
  db: () => import("./db.js"),
};

const requested = process.argv[2]?.replace(/^mcp-/, "");

if (!requested || requested === "--help" || requested === "-h") {
  console.error(
    `Usage: mcp <server>\n\nServers:\n${Object.keys(SERVERS)
      .map((name) => `  mcp-${name}`)
      .join("\n")}`,
  );
  process.exit(requested ? 0 : 1);
}

const load = SERVERS[requested];
if (!load) {
  console.error(
    `Unknown server "${process.argv[2]}". Available: ${Object.keys(SERVERS)
      .map((n) => `mcp-${n}`)
      .join(", ")}`,
  );
  process.exit(1);
}

await load();

export {};
