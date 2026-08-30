import { MAX_CELL, MAX_CHARS } from "./config.js";

export type QueryResult = {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
};

/** One cell, flattened to a single readable line. */
export function renderCell(value: unknown, maxCell = MAX_CELL): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `<blob ${value.byteLength}B>`;
  let text: string;
  if (typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxCell ? `${text.slice(0, maxCell - 1)}…` : text;
}

/**
 * Aligned columns while they fit; falls back to one record per block when the
 * table would be too wide to read.
 */
export function renderTable(
  result: QueryResult,
  opts: { maxChars?: number; maxCell?: number; note?: string } = {},
): string {
  const maxChars = opts.maxChars ?? MAX_CHARS;
  const maxCell = opts.maxCell ?? MAX_CELL;
  const { columns, rows } = result;

  if (!columns.length) return rows.length ? "(no column metadata)" : "(0 rows)";
  if (!rows.length) return `(0 rows)\ncolumns: ${columns.join(", ")}`;

  const cells = rows.map((row) => row.map((v) => renderCell(v, maxCell)));
  const widths = columns.map((col, i) =>
    Math.max(col.length, ...cells.map((row) => (row[i] ?? "").length)),
  );
  const totalWidth = widths.reduce((a, b) => a + b + 3, 0);

  let body: string;
  if (totalWidth > 160) {
    body = cells
      .map(
        (row, n) =>
          `— row ${n + 1}\n` +
          columns.map((col, i) => `  ${col}: ${row[i] ?? ""}`).join("\n"),
      )
      .join("\n");
  } else {
    const line = (values: string[]) =>
      values.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
    body = [
      line(columns),
      widths.map((w) => "─".repeat(w)).join("  "),
      ...cells.map(line),
    ].join("\n");
  }

  let out = body;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    const lastNewline = out.lastIndexOf("\n");
    if (lastNewline > 0) out = out.slice(0, lastNewline);
    out += `\n… output truncated at ${maxChars} chars — select fewer columns or lower \`limit\``;
  }
  return opts.note ? `${out}\n${opts.note}` : out;
}
