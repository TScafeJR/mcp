import type { Driver } from "./driver.js";
import { renderTable, type QueryResult } from "./format.js";

export type TableRef = { schema: string | null; name: string };

/** `schema.table` or `table`; quotes are stripped. */
export function parseTableRef(input: string): TableRef {
  const clean = input.trim().replace(/^["`]|["`]$/g, "");
  const parts = clean.split(".").map((p) => p.replace(/^["`]|["`]$/g, ""));
  if (parts.length >= 2) return { schema: parts[0], name: parts.slice(1).join(".") };
  return { schema: null, name: clean };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const PG_SYSTEM_SCHEMAS = "'pg_catalog','information_schema','pg_toast'";

// --- Overview ---------------------------------------------------------------

export async function overview(driver: Driver): Promise<string> {
  if (driver.dialect === "sqlite") {
    const objects = await driver.query(
      `select name, type from sqlite_master
       where type in ('table','view') and name not like 'sqlite_%'
       order by type, name`,
    );
    if (!objects.rows.length) return "This database has no tables yet.";

    const rows: unknown[][] = [];
    for (const [name, type] of objects.rows as Array<[string, string]>) {
      let count: unknown = "—";
      if (type === "table") {
        const c = await driver.query(`select count(*) as n from ${quoteIdent(name)}`);
        count = c.rows[0]?.[0] ?? 0;
      }
      rows.push([name, type, count]);
    }
    return renderTable({ columns: ["name", "type", "rows"], rows, rowCount: rows.length });
  }

  const result = await driver.query(
    `select n.nspname as schema, c.relname as name,
            case c.relkind when 'r' then 'table' when 'p' then 'partitioned'
                           when 'v' then 'view' when 'm' then 'matview' end as type,
            c.reltuples::bigint as est_rows
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r','p','v','m') and n.nspname not in (${PG_SYSTEM_SCHEMAS})
     order by 1, 2`,
  );
  if (!result.rows.length) return "This database has no user tables yet.";
  return `${renderTable(result)}\n(est_rows is the planner's estimate; -1 means never analyzed)`;
}

// --- Table detail -----------------------------------------------------------

async function sqliteTable(driver: Driver, ref: TableRef): Promise<string> {
  const known = await driver.query(
    `select name, type, sql from sqlite_master where name = ? and type in ('table','view')`,
    [ref.name],
  );
  if (!known.rows.length) {
    throw new Error(
      `No table or view named "${ref.name}". Call db_schema with no arguments to list what exists.`,
    );
  }
  const ddl = known.rows[0][2];
  const ident = quoteIdent(ref.name);
  const sections: string[] = [];

  const columns = await driver.query(`pragma table_info(${ident})`);
  const colRows = columns.rows.map((r) => {
    const [, name, type, notnull, dflt, pk] = r as [
      number, string, string, number, unknown, number,
    ];
    return [name, type || "—", notnull ? "NOT NULL" : "", dflt ?? "", pk ? `PK${pk > 1 ? ` (${pk})` : ""}` : ""];
  });
  sections.push(
    `[COLUMNS]\n${renderTable({
      columns: ["column", "type", "null", "default", "key"],
      rows: colRows,
      rowCount: colRows.length,
    })}`,
  );

  const fks = await driver.query(`pragma foreign_key_list(${ident})`);
  if (fks.rows.length) {
    const rows = fks.rows.map((r) => {
      const rec = r as [number, number, string, string, string, string, string];
      return [rec[3], `${rec[2]}.${rec[4] ?? "rowid"}`, rec[5], rec[6]];
    });
    sections.push(
      `[FOREIGN KEYS]\n${renderTable({
        columns: ["column", "references", "on_update", "on_delete"],
        rows,
        rowCount: rows.length,
      })}`,
    );
  }

  const indexes = await driver.query(`pragma index_list(${ident})`);
  if (indexes.rows.length) {
    const rows: unknown[][] = [];
    for (const r of indexes.rows) {
      const [, name, unique, origin] = r as [number, string, number, string, number];
      const info = await driver.query(`pragma index_info(${quoteIdent(name)})`);
      const cols = info.rows.map((i) => (i as [number, number, string])[2]).join(", ");
      rows.push([name, cols, unique ? "UNIQUE" : "", origin]);
    }
    sections.push(
      `[INDEXES]\n${renderTable({
        columns: ["index", "columns", "unique", "origin"],
        rows,
        rowCount: rows.length,
      })}`,
    );
  }

  // Which tables point at this one — SQLite has no reverse view, so scan.
  const others = await driver.query(
    `select name from sqlite_master where type='table' and name not like 'sqlite_%' and name <> ?`,
    [ref.name],
  );
  const referencing: unknown[][] = [];
  for (const [other] of others.rows as Array<[string]>) {
    const list = await driver.query(`pragma foreign_key_list(${quoteIdent(other)})`);
    for (const r of list.rows) {
      const rec = r as [number, number, string, string, string];
      if (rec[2] === ref.name) referencing.push([other, rec[3], rec[4] ?? "rowid"]);
    }
  }
  if (referencing.length) {
    sections.push(
      `[REFERENCED BY]\n${renderTable({
        columns: ["table", "column", "→ this column"],
        rows: referencing,
        rowCount: referencing.length,
      })}`,
    );
  }

  if (ddl) sections.push(`[DDL]\n${String(ddl).trim()}`);
  return sections.join("\n\n");
}

async function postgresTable(driver: Driver, ref: TableRef): Promise<string> {
  const located = await driver.query(
    `select n.nspname, c.relname
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relname = $1 and ($2::text is null or n.nspname = $2)
       and n.nspname not in (${PG_SYSTEM_SCHEMAS})
     order by (n.nspname = 'public') desc
     limit 1`,
    [ref.name, ref.schema],
  );
  if (!located.rows.length) {
    throw new Error(
      `No table or view named "${ref.schema ? `${ref.schema}.` : ""}${ref.name}". Call db_schema with no arguments to list what exists.`,
    );
  }
  const [schema, name] = located.rows[0] as [string, string];
  const sections: string[] = [`${schema}.${name}`];

  const columns = await driver.query(
    `select column_name, data_type ||
              coalesce('(' || character_maximum_length || ')', '') as type,
            is_nullable, column_default
     from information_schema.columns
     where table_schema = $1 and table_name = $2
     order by ordinal_position`,
    [schema, name],
  );
  sections.push(`[COLUMNS]\n${renderTable(columns)}`);

  const constraints = await driver.query(
    `select con.conname as name, pg_get_constraintdef(con.oid) as definition
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = $1 and c.relname = $2
     order by con.contype, con.conname`,
    [schema, name],
  );
  if (constraints.rows.length) {
    sections.push(`[CONSTRAINTS]\n${renderTable(constraints)}`);
  }

  const indexes = await driver.query(
    `select indexname as name, indexdef as definition
     from pg_indexes where schemaname = $1 and tablename = $2 order by indexname`,
    [schema, name],
  );
  if (indexes.rows.length) sections.push(`[INDEXES]\n${renderTable(indexes)}`);

  const referencedBy = await driver.query(
    `select src_ns.nspname || '.' || src.relname as "table",
            pg_get_constraintdef(con.oid) as definition
     from pg_constraint con
     join pg_class src on src.oid = con.conrelid
     join pg_namespace src_ns on src_ns.oid = src.relnamespace
     join pg_class tgt on tgt.oid = con.confrelid
     join pg_namespace tgt_ns on tgt_ns.oid = tgt.relnamespace
     where con.contype = 'f' and tgt_ns.nspname = $1 and tgt.relname = $2`,
    [schema, name],
  );
  if (referencedBy.rows.length) {
    sections.push(`[REFERENCED BY]\n${renderTable(referencedBy)}`);
  }

  return sections.join("\n\n");
}

export async function describeTable(driver: Driver, table: string): Promise<string> {
  const ref = parseTableRef(table);
  return driver.dialect === "sqlite"
    ? sqliteTable(driver, ref)
    : postgresTable(driver, ref);
}

// --- Search -----------------------------------------------------------------

export async function searchSchema(driver: Driver, term: string): Promise<string> {
  const needle = term.toLowerCase();
  if (driver.dialect === "sqlite") {
    const tables = await driver.query(
      `select name from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name`,
    );
    const hits: unknown[][] = [];
    for (const [name] of tables.rows as Array<[string]>) {
      const info = await driver.query(`pragma table_info(${quoteIdent(name)})`);
      const tableHit = name.toLowerCase().includes(needle);
      for (const row of info.rows) {
        const rec = row as [number, string, string];
        if (tableHit || rec[1].toLowerCase().includes(needle)) {
          hits.push([name, rec[1], rec[2] || "—"]);
        }
      }
    }
    if (!hits.length) return `Nothing in the schema matches "${term}".`;
    return renderTable({
      columns: ["table", "column", "type"],
      rows: hits.slice(0, 200),
      rowCount: hits.length,
    });
  }

  const result = await driver.query(
    `select table_schema || '.' || table_name as "table", column_name, data_type
     from information_schema.columns
     where table_schema not in (${PG_SYSTEM_SCHEMAS})
       and (table_name ilike $1 or column_name ilike $1)
     order by 1, ordinal_position
     limit 200`,
    [`%${term}%`],
  );
  if (!result.rows.length) return `Nothing in the schema matches "${term}".`;
  return renderTable(result);
}
