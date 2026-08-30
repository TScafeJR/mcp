import fs from "node:fs/promises";
import path from "node:path";
import { migrationsDir } from "./config.js";
import type { Driver } from "./driver.js";
import { renderTable } from "./format.js";

/** Ledger tables, most specific first. */
const LEDGERS = [
  { table: "_sqlx_migrations", versionColumn: "version", tool: "sqlx" },
  { table: "supabase_migrations.schema_migrations", versionColumn: "version", tool: "supabase" },
  { table: "__drizzle_migrations", versionColumn: "hash", tool: "drizzle" },
  { table: "schema_migrations", versionColumn: "version", tool: "generic" },
];

type Ledger = {
  tool: string;
  table: string;
  columns: string[];
  rows: unknown[][];
  versions: Set<string>;
  failed: string[];
};

/** Leading digits of a filename are the version for sqlx, supabase and friends. */
function versionOf(filename: string): string | null {
  const match = filename.match(/^(\d+)/);
  return match ? match[1] : null;
}

function normalize(version: string): string {
  return /^\d+$/.test(version) ? String(BigInt(version)) : version;
}

async function findLedger(driver: Driver): Promise<Ledger | null> {
  for (const candidate of LEDGERS) {
    let result;
    try {
      result = await driver.query(`select * from ${candidate.table}`);
    } catch {
      continue; // table absent for this tool — try the next convention
    }
    const versionIndex = result.columns.indexOf(candidate.versionColumn);
    const successIndex = result.columns.indexOf("success");
    const versions = new Set<string>();
    const failed: string[] = [];
    for (const row of result.rows) {
      const version = versionIndex >= 0 ? String(row[versionIndex]) : "";
      if (version) versions.add(normalize(version));
      if (successIndex >= 0 && row[successIndex] === 0) failed.push(version);
    }
    return {
      tool: candidate.tool,
      table: candidate.table,
      columns: result.columns,
      rows: result.rows,
      versions,
      failed,
    };
  }
  return null;
}

export async function migrationReport(driver: Driver): Promise<string> {
  const dir = migrationsDir();
  const ledger = await findLedger(driver);
  const sections: string[] = [];

  if (!dir) {
    sections.push(
      "No migrations directory found. Looked for migrations/, supabase/migrations/, db/migrations/, drizzle/ and prisma/migrations/ under " +
        `${process.cwd()}. Set MCP_DB_MIGRATIONS_DIR to point at it.`,
    );
  }

  sections.push(
    ledger
      ? `Ledger: ${ledger.table} (${ledger.tool} convention), ${ledger.versions.size} applied`
      : "Ledger: none found — this database has no _sqlx_migrations, schema_migrations or __drizzle_migrations table.",
  );

  if (!dir) return sections.join("\n\n");
  sections.unshift(`Directory: ${dir}`);

  const entries = (await fs.readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  // Prisma/drizzle keep one directory per migration rather than flat files.
  const dirEntries = entries.length
    ? []
    : (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
  const files = entries.length ? entries : dirEntries;

  if (!files.length) return `${sections.join("\n\n")}\n\nNo migration files in that directory.`;

  const rows: unknown[][] = [];
  const pending: string[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const version = versionOf(file);
    const normalized = version ? normalize(version) : null;
    if (normalized) seen.add(normalized);
    const applied = ledger
      ? normalized
        ? ledger.versions.has(normalized)
        : ledger.versions.has(file)
      : false;
    if (!applied) pending.push(file);
    rows.push([
      file,
      version ?? "—",
      ledger ? (applied ? "applied" : "PENDING") : "unknown",
    ]);
  }

  sections.push(
    renderTable({ columns: ["file", "version", "state"], rows, rowCount: rows.length }),
  );

  if (ledger) {
    const orphans = Array.from(ledger.versions).filter((v) => !seen.has(v));
    if (orphans.length) {
      sections.push(
        `⚠ Applied to the database but absent from ${path.basename(dir)}/: ${orphans.join(", ")}\n` +
          "  Either the files were deleted, or this database was migrated from a different branch.",
      );
    }
    if (ledger.failed.length) {
      sections.push(`⚠ Recorded as FAILED: ${ledger.failed.join(", ")}`);
    }
    sections.push(
      pending.length
        ? `⚠ ${pending.length} pending migration${pending.length === 1 ? "" : "s"}: ${pending.join(", ")}\n  Run your migration tool — this server is read-only and will not apply them.`
        : "✓ Schema is up to date with the migration files on disk.",
    );
  }

  return sections.join("\n\n");
}
