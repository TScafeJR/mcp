#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import puppeteer, { KnownDevices, Browser } from "puppeteer";
import http from "http";
import https from "https";

// --- Configuration ---
// Resolution order (highest → lowest):
//   1. per-call `base_url` arg (e.g. "https://my-site.netlify.app")
//   2. per-call `port` arg (combined with host below) — kept for back-compat
//   3. MCP_DEV_SERVER_URL env (full base URL)
//   4. MCP_DEV_SERVER_HOST + MCP_DEV_SERVER_PORT env
//   5. http://localhost:3000 (works for CRA, Next.js; vite users set port to 5173,
//      Netlify dev users set it to 8888, etc.)
const DEFAULT_BASE_URL = "http://localhost:3000";

function resolveBaseUrl(args: { base_url?: string; port?: number }): string {
  if (args.base_url) return stripTrailingSlash(args.base_url);
  if (process.env.MCP_DEV_SERVER_URL && !args.port) {
    return stripTrailingSlash(process.env.MCP_DEV_SERVER_URL);
  }
  const host = process.env.MCP_DEV_SERVER_HOST || "localhost";
  const port =
    args.port ??
    (process.env.MCP_DEV_SERVER_PORT
      ? parseInt(process.env.MCP_DEV_SERVER_PORT, 10)
      : undefined);
  if (port !== undefined) return `http://${host}:${port}`;
  return DEFAULT_BASE_URL;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

// --- Utilities ---
async function checkDevServer(baseUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = baseUrl.startsWith("https:") ? https : http;
    const req = client.get(baseUrl, (res) => {
      const ok = res.statusCode !== undefined && res.statusCode < 500;
      resolve(ok);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

type NetworkEntry = {
  url: string;
  method: string;
  status?: number;
  failure?: string;
};

type ConsoleEntry = {
  type: string;
  text: string;
  location?: string;
};

// --- Server Setup ---
const server = new Server(
  {
    name: "user-journey-wizard",
    version: "1.4.0",
  },
  {
    capabilities: { tools: {} },
  },
);

// --- 1. Define Tools ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "screenshot_page",
        description:
          "Takes a screenshot of a running web app (local dev server, Netlify deploy preview, etc.).",
        inputSchema: {
          type: "object",
          properties: {
            route: { type: "string", description: "Path to visit (e.g. /ats)" },
            base_url: {
              type: "string",
              description:
                "Full base URL override (e.g. http://localhost:8888 for Netlify dev, https://preview.example.com). Takes precedence over port and env vars.",
            },
            port: {
              type: "number",
              description:
                "Port on localhost (e.g. 5173 for Vite, 3000 for Next/CRA, 8888 for Netlify dev). Ignored if base_url is set.",
            },
            mobile: { type: "boolean" },
            pwa: {
              type: "boolean",
              description:
                "Simulate iOS PWA/standalone experience: sets display-mode:standalone, emulates iPhone 15 Pro, and injects 34px bottom + 59px top safe area insets.",
            },
            wait_ms: {
              type: "number",
              description:
                "Milliseconds to wait after page load before taking screenshot.",
            },
          },
          required: ["route"],
        },
      },
      {
        name: "type_into_element",
        description:
          "Navigates, types text into a selector, and returns a screenshot.",
        inputSchema: {
          type: "object",
          properties: {
            route: { type: "string" },
            selector: { type: "string" },
            text: { type: "string" },
            base_url: {
              type: "string",
              description: "Full base URL override. See screenshot_page.",
            },
            port: {
              type: "number",
              description: "Localhost port. Ignored if base_url is set.",
            },
            wait_ms: {
              type: "number",
              description:
                "Milliseconds to wait after typing before taking screenshot. Useful for streaming responses (e.g. 10000 for 10s).",
            },
          },
          required: ["route", "selector", "text"],
        },
      },
      {
        name: "inspect_network_errors",
        description:
          "Captures console logs (errors/warns), uncaught JS exceptions, and 4xx/5xx network failures.",
        inputSchema: {
          type: "object",
          properties: {
            route: { type: "string" },
            base_url: {
              type: "string",
              description: "Full base URL override. See screenshot_page.",
            },
            port: {
              type: "number",
              description: "Localhost port. Ignored if base_url is set.",
            },
            include_logs: {
              type: "boolean",
              default: true,
              description: "Whether to include console logs/warnings",
            },
          },
          required: ["route"],
        },
      },
    ],
  };
});

// --- 2. Handle Tool Execution ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments as any;
  const baseUrl = resolveBaseUrl(args);
  const url = `${baseUrl}${args.route || "/"}`;

  const isServerRunning = await checkDevServer(baseUrl);
  if (!isServerRunning) {
    return {
      content: [
        { type: "text", text: `Error: Server not reachable at ${url}` },
      ],
      isError: true,
    };
  }

  let browser: Browser | null = null;
  const closeBrowser = async () => {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error("Failed to close browser:", (e as Error).message);
      }
      browser = null;
    }
  };

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();

    if (toolName === "inspect_network_errors") {
      const networkEntries: NetworkEntry[] = [];
      const consoleEntries: ConsoleEntry[] = [];

      // 1. Capture Network Failures
      page.on("requestfailed", (req) => {
        networkEntries.push({
          url: req.url(),
          method: req.method(),
          failure: req.failure()?.errorText || "Unknown",
        });
      });

      page.on("response", (res) => {
        if (res.status() >= 400) {
          networkEntries.push({
            url: res.url(),
            method: res.request().method(),
            status: res.status(),
          });
        }
      });

      // 2. Capture Console Messages (Logs/Warns/Errors)
      page.on("console", (msg) => {
        const type = msg.type();
        if (type === "error" || type === "warn") {
          consoleEntries.push({
            type: type.toUpperCase(),
            text: msg.text(),
          });
        }
      });

      // 3. Capture Uncaught Exceptions (Page Errors)
      page.on("pageerror", (err) => {
        consoleEntries.push({
          type: "EXCEPTION",
          text: (err as Error).message,
        });
      });

      await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

      // Format results
      let report = `Diagnostic Report for ${url}\n${"=".repeat(40)}\n\n`;

      report += `[NETWORK ERRORS]\n`;
      report += networkEntries.length
        ? networkEntries
            .map(
              (e) =>
                `- [${e.status || "FAIL"}] ${e.method} ${e.url} ${e.failure ? `(${e.failure})` : ""}`,
            )
            .join("\n")
        : "No network errors detected.\n";

      report += `\n\n[CONSOLE & JS ERRORS]\n`;
      report += consoleEntries.length
        ? consoleEntries.map((e) => `- [${e.type}] ${e.text}`).join("\n")
        : "No console errors detected.\n";

      return { content: [{ type: "text", text: report }] };
    }

    // --- Handling for Screenshot / Interaction tools ---
    const isMobile = args.mobile || args.pwa;
    if (isMobile) await page.emulate(KnownDevices["iPhone 15 Pro"]);

    if (args.pwa) {
      // Simulate PWA/standalone display mode
      await page.emulateMediaFeatures([
        { name: "display-mode", value: "standalone" },
      ]);

      // Inject safe area insets before page scripts run.
      // Chromium headless always returns 0 for env(safe-area-inset-*) so we
      // patch it by overriding the computed padding on affected elements via CSS.
      await page.evaluateOnNewDocument(() => {
        document.addEventListener("DOMContentLoaded", () => {
          const style = document.createElement("style");
          style.dataset.pwaSimulation = "true";
          style.textContent = `
            /* ── PWA safe-area simulation (34px bottom / 59px top) ── */

            /* Main content bottom clearance */
            .pb-nav-safe { padding-bottom: calc(5rem + 34px) !important; }
            .pb-safe     { padding-bottom: 34px !important; }

            /* Bottom tab bar inner padding */
            nav[class*="fixed"][class*="bottom"] > div {
              padding-bottom: 34px !important;
            }

            /* Chat input footer */
            [class*="border-t"][class*="bg-white"] { padding-bottom: 24px !important; }

            /* Visual guide: faint overlay bars showing safe areas */
            body::before, body::after {
              content: '';
              position: fixed;
              left: 0; right: 0;
              z-index: 9999;
              pointer-events: none;
              background: rgba(255, 100, 0, 0.12);
            }
            body::before { top: 0; height: 59px; }  /* Dynamic Island */
            body::after  { bottom: 0; height: 34px; } /* Home indicator */
          `;
          document.head.appendChild(style);
        });
      });
    }

    await page.goto(url, { waitUntil: "networkidle0" });

    if (toolName === "type_into_element") {
      await page.waitForSelector(args.selector, { timeout: 5000 });
      await page.type(args.selector, args.text);
    }

    // Optional delay before screenshot (useful for streaming responses, animations, etc.)
    if (args.wait_ms && args.wait_ms > 0) {
      const waitTime = Math.min(args.wait_ms, 120000); // Cap at 2 minutes
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    // For mobile/PWA use viewport-only (reflects real user experience).
    // For desktop use fullPage to capture the entire document.
    const base64Image = await page.screenshot({
      encoding: "base64",
      fullPage: !isMobile,
    });
    return {
      content: [
        { type: "text", text: `Action performed on ${url}` },
        { type: "image", data: base64Image, mimeType: "image/png" },
      ],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  } finally {
    await closeBrowser();
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch(() => process.exit(1));
