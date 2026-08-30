import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Dialect = "sqlite" | "postgres";

export type DbTarget = {
  dialect: Dialect;
  /** Connection string for postgres, absolute file path for sqlite. */
  target: string;
  /** Safe-to-print description — never contains credentials. */
  label: string;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const MAX_ROWS = envInt("MCP_DB_MAX_ROWS", 50);
export const MAX_CHARS = envInt("MCP_DB_MAX_CHARS", 8_000);
export const MAX_CELL = envInt("MCP_DB_MAX_CELL", 60);
export const STATEMENT_TIMEOUT_MS = envInt("MCP_DB_TIMEOUT_MS", 10_000);
export const BUSY_TIMEOUT_MS = envInt("MCP_DB_BUSY_TIMEOUT_MS", 3_000);

const SQLITE_EXTENSIONS = /\.(db|sqlite|sqlite3|db3)$/i;

/**
 * Expands a leading `~`. Deliberately not general shell expansion: a Postgres
 * password may legitimately contain `$`, so expanding $VAR would corrupt real
 * connection strings.
 */
function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

/** Strips credentials so a connection can be named in output safely. */
export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Reads MCP_DB_URL. Accepts postgres URLs, `sqlite:`/`file:` URLs (the form
 * sqlx uses, query string and all) and bare paths to a SQLite file.
 */
export function resolveTarget(): DbTarget {
  const raw = process.env.MCP_DB_URL?.trim();
  if (!raw) {
    throw new Error(
      "MCP_DB_URL is not set. Point it at a database, e.g.\n" +
        '  "env": { "MCP_DB_URL": "sqlite:./data/app.db" }\n' +
        '  "env": { "MCP_DB_URL": "postgresql://user:pass@host:5432/dbname" }',
    );
  }

  if (/^postgres(ql)?:\/\//i.test(raw)) {
    return { dialect: "postgres", target: raw, label: redact(raw) };
  }

  let filePath: string | null = null;
  if (/^sqlite:/i.test(raw)) {
    // sqlx style: sqlite:data/app.db?mode=rwc, sqlite://data/app.db
    filePath = raw.replace(/^sqlite:(\/\/)?/i, "").split("?")[0];
  } else if (/^file:/i.test(raw)) {
    filePath = raw.replace(/^file:(\/\/)?/i, "").split("?")[0];
  } else if (SQLITE_EXTENSIONS.test(raw) || raw.startsWith(".") || raw.startsWith("/")) {
    filePath = raw.split("?")[0];
  }

  if (filePath) {
    if (filePath === ":memory:") {
      throw new Error("An in-memory SQLite database has nothing to inspect.");
    }
    const absolute = path.resolve(process.cwd(), expandHome(decodeURIComponent(filePath)));
    if (!fs.existsSync(absolute)) {
      throw new Error(
        `No SQLite database at ${absolute}\n` +
          `(MCP_DB_URL="${raw}", resolved against cwd ${process.cwd()}). ` +
          "Run your migrations first, or set an absolute path.",
      );
    }
    return { dialect: "sqlite", target: absolute, label: absolute };
  }

  throw new Error(
    `Could not tell what kind of database "${redact(raw)}" is. Use a postgres:// URL, a sqlite: URL, or a path to a .db file.`,
  );
}

const MIGRATION_DIRS = [
  "migrations",
  "supabase/migrations",
  "db/migrations",
  "drizzle",
  "prisma/migrations",
];

/** Explicit env wins; otherwise take the first conventional directory present. */
export function migrationsDir(): string | null {
  const explicit = process.env.MCP_DB_MIGRATIONS_DIR;
  if (explicit) {
    const abs = path.resolve(process.cwd(), explicit);
    return fs.existsSync(abs) ? abs : null;
  }
  for (const candidate of MIGRATION_DIRS) {
    const abs = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return abs;
  }
  return null;
}
