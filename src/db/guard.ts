/**
 * Statement-level read-only gate.
 *
 * This is the outer layer only — the real guarantee is the engine: SQLite is
 * opened `readOnly`, and Postgres statements run inside a READ ONLY
 * transaction. This exists to reject obvious writes with a clear message
 * before they reach the driver, and to catch data-modifying CTEs
 * (`WITH x AS (DELETE ... RETURNING ...)`) which do begin with WITH.
 */

const ALLOWED_LEADERS = new Set(["select", "with", "explain", "show", "table", "values"]);

const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|reindex|attach|detach|merge|call|do|refresh|comment|cluster|lock|notify|set|begin|commit|rollback|savepoint)\b/i;

/** Removes comments and string/identifier literals so keyword scanning is safe. */
export function stripLiterals(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === ch) {
          // Doubled quote is an escaped quote, not a terminator.
          if (sql[i + 1] === ch) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (sql[i] === "\\") i++;
        i++;
      }
      out += " ";
      continue;
    }
    if (ch === "$" && /\$[a-zA-Z_]*\$/.test(sql.slice(i, i + 20))) {
      // Postgres dollar-quoted body — skip to the matching tag.
      const tag = sql.slice(i).match(/^\$[a-zA-Z_]*\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        out += " ";
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function assertReadOnly(sql: string): void {
  const bare = stripLiterals(sql).trim().replace(/;\s*$/, "");
  if (!bare) throw new Error("Empty statement.");

  if (bare.includes(";")) {
    throw new Error("Only one statement per call. Chained statements are rejected outright.");
  }

  const leader = bare.match(/^\(*\s*([a-z]+)/i)?.[1]?.toLowerCase() ?? "";
  if (!ALLOWED_LEADERS.has(leader)) {
    throw new Error(
      `This server is read-only, so it will not run a "${leader.toUpperCase()}" statement. Allowed: SELECT, WITH, EXPLAIN, SHOW, TABLE, VALUES.`,
    );
  }

  const write = bare.match(WRITE_KEYWORDS);
  if (write) {
    throw new Error(
      `Rejected: the statement contains "${write[1].toUpperCase()}", which can modify data (a CTE such as WITH x AS (DELETE ...) starts with WITH but still writes). If this is a false positive on a column or alias name, quote the identifier.`,
    );
  }
}
