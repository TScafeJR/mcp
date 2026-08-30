import {
  BUSY_TIMEOUT_MS,
  STATEMENT_TIMEOUT_MS,
  resolveTarget,
  type DbTarget,
  type Dialect,
} from "./config.js";
import type { QueryResult } from "./format.js";

export interface Driver {
  dialect: Dialect;
  label: string;
  version(): Promise<string>;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

function rowsToColumns(
  records: Array<Record<string, unknown>>,
  fallback: string[] = [],
): QueryResult {
  const columns = records.length ? Object.keys(records[0]) : fallback;
  return {
    columns,
    rows: records.map((r) => columns.map((c) => r[c])),
    rowCount: records.length,
  };
}

/** SQLite via node:sqlite — no dependency, and readOnly is enforced by the engine. */
async function openSqlite(target: DbTarget): Promise<Driver> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error(
      "SQLite support needs Node's built-in node:sqlite module (Node 22.5 or newer). " +
        `This process is ${process.version}.`,
    );
  }

  const db = new sqlite.DatabaseSync(target.target, { readOnly: true });
  // The project's own app may be mid-write; wait briefly rather than failing
  // the call with SQLITE_BUSY.
  try {
    db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {
    /* older runtime — the default of 0 still works, it just gives up sooner */
  }

  return {
    dialect: "sqlite",
    label: target.label,
    async version() {
      const row = db.prepare("select sqlite_version() as v").get() as {
        v: string;
      };
      return `SQLite ${row.v}`;
    },
    async query(sql, params = []) {
      const statement = db.prepare(sql);
      const records = statement.all(
        ...(params as never[]),
      ) as Array<Record<string, unknown>>;
      let fallback: string[] = [];
      try {
        // Available in newer Node; gives column names even for empty results.
        fallback = (statement as unknown as { columns(): Array<{ name: string }> })
          .columns()
          .map((c) => c.name);
      } catch {
        /* older runtime — fall back to the keys of the first row */
      }
      return rowsToColumns(records, fallback);
    },
    async close() {
      db.close();
    },
  };
}

/** Postgres via `pg`, imported lazily so SQLite-only projects never load it. */
async function openPostgres(target: DbTarget): Promise<Driver> {
  let Client: new (config: unknown) => any;
  try {
    const mod: any = await import("pg");
    Client = (mod.default ?? mod).Client;
  } catch {
    throw new Error(
      "Postgres support needs the `pg` package, which should ship with this server. Reinstall @tscafejr/mcp.",
    );
  }

  let host = "";
  try {
    host = new URL(target.target).hostname;
  } catch {
    /* leave blank and default to requiring TLS */
  }
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";

  const client = new Client({
    connectionString: target.target,
    // Managed Postgres (Supabase, Neon, RDS) terminates TLS with a chain node
    // does not trust by default; this is a read-only dev tool, not a secret store.
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();

  return {
    dialect: "postgres",
    label: target.label,
    async version() {
      const res = await client.query("select version() as v");
      return String(res.rows[0]?.v ?? "PostgreSQL").split(" on ")[0];
    },
    async query(sql, params = []) {
      // Every statement runs inside a READ ONLY transaction: writes fail at the
      // engine, not just at our own keyword check.
      await client.query("begin read only");
      try {
        await client.query(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const res = await client.query({ text: sql, values: params, rowMode: "array" });
        const columns = (res.fields ?? []).map((f: { name: string }) => f.name);
        return {
          columns,
          rows: (res.rows ?? []) as unknown[][],
          rowCount: res.rows?.length ?? 0,
        };
      } finally {
        await client.query("rollback").catch(() => {});
      }
    },
    async close() {
      await client.end().catch(() => {});
    },
  };
}

let cached: Driver | null = null;

export async function getDriver(): Promise<Driver> {
  if (cached) return cached;
  const target = resolveTarget();
  cached =
    target.dialect === "sqlite"
      ? await openSqlite(target)
      : await openPostgres(target);
  return cached;
}

export async function closeDriver(): Promise<void> {
  const driver = cached;
  cached = null;
  if (driver) await driver.close().catch(() => {});
}
