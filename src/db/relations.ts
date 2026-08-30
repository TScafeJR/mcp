import type { Driver } from "./driver.js";
import { renderTable } from "./format.js";

export type Edge = {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  kind: "fk" | "inferred";
};

type Graph = {
  tables: string[];
  edges: Edge[];
  primaryKey: Map<string, string>;
};

const bare = (table: string): string => table.split(".").pop() ?? table;

/** users → user, categories → category, boxes → box. */
function singularForms(name: string): string[] {
  const forms = new Set([name]);
  if (name.endsWith("ies")) forms.add(`${name.slice(0, -3)}y`);
  if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes")) {
    forms.add(name.slice(0, -2));
  }
  if (name.endsWith("s") && !name.endsWith("ss")) forms.add(name.slice(0, -1));
  return [...forms];
}

/**
 * Declared foreign keys are the truth, but plenty of schemas carry the
 * relationship in the column name alone — `player_id` pointing at `player`
 * without a REFERENCES clause. Those are reported too, marked `inferred`.
 */
function inferEdges(
  tables: string[],
  columnsByTable: Map<string, string[]>,
  primaryKey: Map<string, string>,
  declared: Edge[],
): Edge[] {
  const byBareName = new Map<string, string>();
  for (const table of tables) {
    for (const form of singularForms(bare(table).toLowerCase())) {
      if (!byBareName.has(form)) byBareName.set(form, table);
    }
    byBareName.set(bare(table).toLowerCase(), table);
  }

  const alreadyDeclared = new Set(declared.map((e) => `${e.from}.${e.fromColumn}`));
  const inferred: Edge[] = [];

  for (const table of tables) {
    for (const column of columnsByTable.get(table) ?? []) {
      const match = column.match(/^(.+)_id$/i);
      if (!match) continue;
      if (alreadyDeclared.has(`${table}.${column}`)) continue;

      const stem = match[1].toLowerCase();
      const target =
        byBareName.get(stem) ??
        singularForms(stem)
          .map((f) => byBareName.get(f))
          .find(Boolean);
      if (!target || target === table) continue;

      inferred.push({
        from: table,
        fromColumn: column,
        to: target,
        toColumn: primaryKey.get(target) ?? "id",
        kind: "inferred",
      });
    }
  }
  return inferred;
}

async function sqliteGraph(driver: Driver): Promise<Graph> {
  const tablesResult = await driver.query(
    `select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name`,
  );
  const tables = tablesResult.rows.map((r) => String(r[0]));
  const columnsByTable = new Map<string, string[]>();
  const primaryKey = new Map<string, string>();
  const declared: Edge[] = [];

  for (const table of tables) {
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const info = await driver.query(`pragma table_info(${quoted})`);
    const columns: string[] = [];
    for (const row of info.rows) {
      const [, name, , , , pk] = row as [number, string, string, number, unknown, number];
      columns.push(name);
      if (pk === 1) primaryKey.set(table, name);
    }
    columnsByTable.set(table, columns);

    const fks = await driver.query(`pragma foreign_key_list(${quoted})`);
    for (const row of fks.rows) {
      const rec = row as [number, number, string, string, string];
      declared.push({
        from: table,
        fromColumn: rec[3],
        to: rec[2],
        toColumn: rec[4] ?? primaryKey.get(rec[2]) ?? "id",
        kind: "fk",
      });
    }
  }

  return {
    tables,
    primaryKey,
    edges: [...declared, ...inferEdges(tables, columnsByTable, primaryKey, declared)],
  };
}

async function postgresGraph(driver: Driver): Promise<Graph> {
  const SYSTEM = "'pg_catalog','information_schema','pg_toast'";

  const columnsResult = await driver.query(
    `select table_schema || '.' || table_name as t, column_name
     from information_schema.columns
     where table_schema not in (${SYSTEM})
     order by 1, ordinal_position`,
  );
  const columnsByTable = new Map<string, string[]>();
  for (const [table, column] of columnsResult.rows as Array<[string, string]>) {
    const list = columnsByTable.get(table) ?? [];
    list.push(column);
    columnsByTable.set(table, list);
  }

  const pkResult = await driver.query(
    `select ns.nspname || '.' || c.relname as t, att.attname
     from pg_constraint con
     join pg_class c on c.oid = con.conrelid
     join pg_namespace ns on ns.oid = c.relnamespace
     join lateral unnest(con.conkey) as k(attnum) on true
     join pg_attribute att on att.attrelid = c.oid and att.attnum = k.attnum
     where con.contype = 'p' and ns.nspname not in (${SYSTEM})`,
  );
  const primaryKey = new Map<string, string>();
  for (const [table, column] of pkResult.rows as Array<[string, string]>) {
    if (!primaryKey.has(table)) primaryKey.set(table, column);
  }

  const fkResult = await driver.query(
    `select src_ns.nspname || '.' || src.relname as from_table, src_att.attname,
            tgt_ns.nspname || '.' || tgt.relname as to_table, tgt_att.attname
     from pg_constraint con
     join pg_class src on src.oid = con.conrelid
     join pg_namespace src_ns on src_ns.oid = src.relnamespace
     join pg_class tgt on tgt.oid = con.confrelid
     join pg_namespace tgt_ns on tgt_ns.oid = tgt.relnamespace
     join lateral unnest(con.conkey, con.confkey) as k(src_attnum, tgt_attnum) on true
     join pg_attribute src_att on src_att.attrelid = src.oid and src_att.attnum = k.src_attnum
     join pg_attribute tgt_att on tgt_att.attrelid = tgt.oid and tgt_att.attnum = k.tgt_attnum
     where con.contype = 'f' and src_ns.nspname not in (${SYSTEM})`,
  );
  const declared: Edge[] = fkResult.rows.map((r) => {
    const [from, fromColumn, to, toColumn] = r as [string, string, string, string];
    return { from, fromColumn, to, toColumn, kind: "fk" as const };
  });

  const tables = [...columnsByTable.keys()];
  return {
    tables,
    primaryKey,
    edges: [...declared, ...inferEdges(tables, columnsByTable, primaryKey, declared)],
  };
}

async function buildGraph(driver: Driver): Promise<Graph> {
  return driver.dialect === "sqlite" ? sqliteGraph(driver) : postgresGraph(driver);
}

function resolveTable(graph: Graph, input: string): string {
  const wanted = input.trim().toLowerCase();
  const exact = graph.tables.find((t) => t.toLowerCase() === wanted);
  if (exact) return exact;
  const byBare = graph.tables.filter((t) => bare(t).toLowerCase() === wanted);
  if (byBare.length === 1) return byBare[0];
  if (byBare.length > 1) {
    throw new Error(
      `"${input}" is ambiguous — it matches ${byBare.join(", ")}. Qualify it with the schema.`,
    );
  }
  throw new Error(`No table named "${input}". Call db_schema with no arguments to list them.`);
}

/** Undirected BFS, preferring declared foreign keys before inferred links. */
function findPath(graph: Graph, from: string, to: string): Edge[] | null {
  for (const allowInferred of [false, true]) {
    const usable = graph.edges.filter((e) => allowInferred || e.kind === "fk");
    const queue: Array<{ table: string; path: Edge[] }> = [{ table: from, path: [] }];
    const seen = new Set([from]);

    while (queue.length) {
      const current = queue.shift() as { table: string; path: Edge[] };
      if (current.table === to) return current.path;
      for (const edge of usable) {
        let next: string | null = null;
        if (edge.from === current.table) next = edge.to;
        else if (edge.to === current.table) next = edge.from;
        if (!next || seen.has(next)) continue;
        seen.add(next);
        queue.push({ table: next, path: [...current.path, edge] });
      }
    }
  }
  return null;
}

function aliasFor(table: string, taken: Set<string>): string {
  const name = bare(table);
  const initials =
    name
      .split("_")
      .map((p) => p[0])
      .join("") || name.slice(0, 1);
  let alias = initials;
  let n = 2;
  while (taken.has(alias)) alias = `${initials}${n++}`;
  taken.add(alias);
  return alias;
}

/** Turns a path into SQL you can paste into db_query. */
function pathToSql(path: Edge[], start: string): string {
  const taken = new Set<string>();
  const aliases = new Map<string, string>();
  aliases.set(start, aliasFor(start, taken));

  const lines = [`SELECT *`, `FROM ${start} ${aliases.get(start)}`];
  let current = start;

  for (const edge of path) {
    const next = edge.from === current ? edge.to : edge.from;
    const alias = aliasFor(next, taken);
    aliases.set(next, alias);
    const left =
      edge.from === current
        ? `${aliases.get(edge.from)}.${edge.fromColumn}`
        : `${alias}.${edge.fromColumn}`;
    const right =
      edge.to === next ? `${alias}.${edge.toColumn}` : `${aliases.get(edge.to)}.${edge.toColumn}`;
    lines.push(`JOIN ${next} ${alias} ON ${left} = ${right}`);
    current = next;
  }
  return lines.join("\n");
}

export async function relationsReport(
  driver: Driver,
  opts: { table?: string; from?: string; to?: string } = {},
): Promise<string> {
  const graph = await buildGraph(driver);

  if (!graph.edges.length) {
    return "No relationships found — no foreign keys are declared and no columns follow the `<table>_id` convention.";
  }

  const legend =
    "kind: fk = declared foreign key, inferred = matched by column naming convention (verify before relying on it)";

  if (opts.from && opts.to) {
    const from = resolveTable(graph, opts.from);
    const to = resolveTable(graph, opts.to);
    if (from === to) return `${from} is the same table on both sides.`;

    const path = findPath(graph, from, to);
    if (!path) {
      return `No join path connects ${from} to ${to}, by declared foreign key or naming convention.`;
    }
    const hops = path.map(
      (e) => `${bare(e.from)}.${e.fromColumn} → ${bare(e.to)}.${e.toColumn} [${e.kind}]`,
    );
    return [
      `${from} → ${to} in ${path.length} hop${path.length === 1 ? "" : "s"}`,
      "",
      hops.map((h) => `  ${h}`).join("\n"),
      "",
      pathToSql(path, from),
      "",
      legend,
    ].join("\n");
  }

  const edges = opts.table
    ? (() => {
        const table = resolveTable(graph, opts.table);
        const touching = graph.edges.filter((e) => e.from === table || e.to === table);
        if (!touching.length)
          throw new Error(`Nothing references ${table}, and it references nothing.`);
        return touching;
      })()
    : graph.edges;

  const rows = edges.map((e) => [`${e.from}.${e.fromColumn}`, `${e.to}.${e.toColumn}`, e.kind]);
  const declaredCount = edges.filter((e) => e.kind === "fk").length;

  return [
    renderTable({ columns: ["from", "to", "kind"], rows, rowCount: rows.length }),
    "",
    `${edges.length} relationship${edges.length === 1 ? "" : "s"} — ${declaredCount} declared, ${edges.length - declaredCount} inferred`,
    legend,
  ].join("\n");
}
