import path from "node:path";

export const DEFAULT_BASE_URL = "http://localhost:3000";

export type TargetArgs = {
  url?: string;
  base_url?: string;
  port?: number;
  route?: string;
};

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Base URL resolution, highest precedence first:
 *   1. per-call `base_url`
 *   2. per-call `port` (localhost shorthand)
 *   3. MCP_DEV_SERVER_URL
 *   4. MCP_DEV_SERVER_HOST + MCP_DEV_SERVER_PORT
 *   5. http://localhost:3000
 */
export function resolveBaseUrl(args: TargetArgs = {}): string {
  if (args.base_url) return stripTrailingSlash(args.base_url);
  if (process.env.MCP_DEV_SERVER_URL && !args.port) {
    return stripTrailingSlash(process.env.MCP_DEV_SERVER_URL);
  }
  const host = process.env.MCP_DEV_SERVER_HOST || "localhost";
  const port =
    args.port ??
    (process.env.MCP_DEV_SERVER_PORT
      ? Number.parseInt(process.env.MCP_DEV_SERVER_PORT, 10)
      : undefined);
  if (port !== undefined && Number.isFinite(port)) {
    return `http://${host}:${port}`;
  }
  return DEFAULT_BASE_URL;
}

/** Full URL for a call. `url` wins outright; an absolute `route` is honoured too. */
export function resolveUrl(args: TargetArgs = {}): string {
  if (args.url) return args.url;
  const route = args.route ?? "/";
  if (/^https?:\/\//i.test(route)) return route;
  const base = resolveBaseUrl(args);
  return `${base}${route.startsWith("/") ? route : `/${route}`}`;
}

/** True when the call carries no target hint at all, so the live page should be reused. */
export function hasTarget(args: TargetArgs = {}): boolean {
  return Boolean(args.url || args.route || args.base_url || args.port);
}

export const IDLE_MS = envInt("MCP_VISUALIZER_IDLE_MS", 5 * 60_000);
export const MAX_EVENTS = envInt("MCP_VISUALIZER_MAX_EVENTS", 500);
export const NAV_TIMEOUT = envInt("MCP_VISUALIZER_NAV_TIMEOUT_MS", 30_000);
export const SETTLE_TIMEOUT = envInt("MCP_VISUALIZER_SETTLE_TIMEOUT_MS", 5_000);
export const DEFAULT_MAX_WIDTH = envInt("MCP_VISUALIZER_MAX_WIDTH", 1000);
export const DEFAULT_MAX_HEIGHT = envInt("MCP_VISUALIZER_MAX_HEIGHT", 4000);

export const DEFAULT_VIEWPORT = {
  width: envInt("MCP_VISUALIZER_WIDTH", 1280),
  height: envInt("MCP_VISUALIZER_HEIGHT", 800),
  deviceScaleFactor: 1,
};

export const BASELINE_DIR =
  process.env.MCP_VISUALIZER_BASELINE_DIR || path.join(process.cwd(), ".visualizer-baselines");

/** Legacy tool names stay listed unless explicitly disabled. */
export const LEGACY_TOOLS = process.env.MCP_VISUALIZER_LEGACY_TOOLS !== "0";

/** Set MCP_VISUALIZER_HEADFUL=1 to watch the browser drive itself. */
export const HEADLESS = process.env.MCP_VISUALIZER_HEADFUL !== "1";

/** JSON object of headers, e.g. {"x-vercel-protection-bypass":"..."} */
export function extraHeaders(): Record<string, string> | undefined {
  const raw = process.env.MCP_DEV_SERVER_HEADERS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    }
  } catch {
    /* fall through — bad JSON is reported by the caller via configWarnings */
  }
  return undefined;
}

/** "user:pass" for HTTP basic auth (password-protected deploy previews). */
export function basicAuth(): { username: string; password: string } | undefined {
  const raw = process.env.MCP_DEV_SERVER_BASIC_AUTH;
  if (!raw) return undefined;
  const idx = raw.indexOf(":");
  if (idx < 0) return undefined;
  return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

export function configWarnings(): string[] {
  const warnings: string[] = [];
  if (process.env.MCP_DEV_SERVER_HEADERS && !extraHeaders()) {
    warnings.push("MCP_DEV_SERVER_HEADERS is set but is not a valid JSON object — ignored.");
  }
  if (process.env.MCP_DEV_SERVER_BASIC_AUTH && !basicAuth()) {
    warnings.push('MCP_DEV_SERVER_BASIC_AUTH is set but is not in "user:pass" form — ignored.');
  }
  return warnings;
}
