#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { callTool, tools } from "../db/tools.js";
import { closeDriver } from "../db/driver.js";
import { resolveTarget } from "../db/config.js";

// node:sqlite is still flagged experimental; its warning on every start reads
// as an error in some MCP clients.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.error(warning);
});

async function version(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Report configuration problems at startup instead of on the first tool call.
// Stderr only — exiting here would surface as an opaque "server failed to
// connect" in most clients, which is strictly less useful.
try {
  const target = resolveTarget();
  console.error(`mcp-db: ${target.dialect} → ${target.label}`);
} catch (err) {
  console.error(`mcp-db: configuration problem — ${(err as Error).message}`);
}

const server = new Server(
  { name: "db", version: await version() },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params.name, request.params.arguments),
);

async function shutdown(): Promise<void> {
  await closeDriver().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("close", () => void shutdown());

const transport = new StdioServerTransport();
await server.connect(transport);
