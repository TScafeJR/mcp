import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MAX_ROWS } from "./config.js";
import { getDriver } from "./driver.js";
import { assertReadOnly, stripLiterals } from "./guard.js";
import { renderTable } from "./format.js";
import { describeTable, overview, searchSchema } from "./introspect.js";
import { migrationReport } from "./migrations.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export const tools: Tool[] = [
  {
    name: "db_schema",
    description:
      "Inspect the database structure. With no arguments: every table and view with row counts. With `table`: columns, types, nullability, defaults, keys, indexes, foreign keys in both directions, and the DDL. With `search`: find tables or columns by name. Read this before writing a query instead of guessing at column names.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table or view to describe, e.g. users or public.users." },
        search: { type: "string", description: "Substring to match against table and column names." },
      },
    },
  },
  {
    name: "db_query",
    description:
      "Run a read-only SELECT and get the rows back. Results are capped, so add your own ORDER BY when the top rows matter. Writes are rejected and the connection itself is read-only.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT / WITH / VALUES statement." },
        limit: { type: "number", description: `Max rows to return (default ${MAX_ROWS}, hard cap 1000).` },
      },
      required: ["sql"],
    },
  },
  {
    name: "db_explain",
    description:
      "Show the query plan for a statement — which indexes are used, where a sequential scan happens. Use it when a query is slow or when checking that an index is actually doing its job.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "The statement to plan." },
        analyze: {
          type: "boolean",
          description:
            "Postgres only: actually execute the query to get real timings and row counts. Still read-only. Default false.",
        },
      },
      required: ["sql"],
    },
  },
  {
    name: "db_migrations",
    description:
      "Compare the migration files on disk against what the database has actually applied. Reports pending migrations, migrations applied but missing from disk (a branch mismatch), and failed ones. Understands sqlx, Supabase, Drizzle and plain schema_migrations ledgers.",
    inputSchema: { type: "object", properties: {} },
  },
];

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** EXPLAIN and SHOW cannot be wrapped in a subquery to cap their rows. */
function isWrappable(sql: string): boolean {
  const leader = stripLiterals(sql).trim().match(/^\(*\s*([a-z]+)/i)?.[1]?.toLowerCase();
  return leader === "select" || leader === "with" || leader === "table" || leader === "values";
}

export async function callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const args: any = rawArgs ?? {};

  try {
    const driver = await getDriver();

    switch (name) {
      case "db_schema": {
        if (args.search) return ok(await searchSchema(driver, String(args.search)));
        if (args.table) return ok(await describeTable(driver, String(args.table)));
        const header = `${await driver.version()} — ${driver.label}`;
        return ok(`${header}\n${"─".repeat(Math.min(header.length, 70))}\n${await overview(driver)}`);
      }

      case "db_query": {
        const sql = String(args.sql ?? "");
        assertReadOnly(sql);
        const limit = Math.min(Math.max(Number(args.limit) || MAX_ROWS, 1), 1000);
        const bare = sql.trim().replace(/;\s*$/, "");

        // Fetch one extra row to tell "exactly N" from "at least N".
        const statement = isWrappable(bare)
          ? `select * from (${bare}) as _mcp_capped limit ${limit + 1}`
          : bare;
        const result = await driver.query(statement);

        const hasMore = result.rows.length > limit;
        if (hasMore) result.rows = result.rows.slice(0, limit);
        const note = hasMore
          ? `(showing the first ${limit} rows — more exist; raise \`limit\` or narrow the query)`
          : `(${result.rows.length} row${result.rows.length === 1 ? "" : "s"})`;
        return ok(renderTable(result, { note }));
      }

      case "db_explain": {
        const sql = String(args.sql ?? "");
        assertReadOnly(sql);
        const bare = sql.trim().replace(/;\s*$/, "");
        if (driver.dialect === "sqlite") {
          const result = await driver.query(`explain query plan ${bare}`);
          // Plan detail is the whole point — don't clip it to the cell default.
          return ok(renderTable(result, { maxCell: 300 }));
        }
        const options = args.analyze
          ? "analyze true, buffers true, format text"
          : "format text";
        const result = await driver.query(`explain (${options}) ${bare}`);
        return ok(result.rows.map((r) => String(r[0])).join("\n") || "(empty plan)");
      }

      case "db_migrations":
        return ok(await migrationReport(driver));

      default:
        return fail(`Unknown tool "${name}".`);
    }
  } catch (err) {
    return fail((err as Error).message);
  }
}
