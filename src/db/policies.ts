import type { Driver } from "./driver.js";
import { renderTable } from "./format.js";

const SYSTEM = "'pg_catalog','information_schema','pg_toast'";

type RlsStatus = { table: string; enabled: boolean; forced: boolean };
type Policy = {
  table: string;
  name: string;
  permissive: string;
  roles: string;
  command: string;
  using: string | null;
  withCheck: string | null;
};

/**
 * Row-level security is invisible from application code and fails silently —
 * a query returns zero rows rather than an error. The two states worth
 * shouting about are RLS enabled with no policies (denies everything) and RLS
 * off entirely (no row filtering at all).
 */
export async function policiesReport(
  driver: Driver,
  opts: { table?: string } = {},
): Promise<string> {
  if (driver.dialect !== "postgres") {
    return "Row-level security is a Postgres feature; this connection is SQLite. Access control lives in your application layer here.";
  }

  const statusResult = await driver.query(
    `select ns.nspname || '.' || c.relname as t,
            c.relrowsecurity, c.relforcerowsecurity
     from pg_class c
     join pg_namespace ns on ns.oid = c.relnamespace
     where c.relkind in ('r','p') and ns.nspname not in (${SYSTEM})
     order by 1`,
  );
  const statuses: RlsStatus[] = statusResult.rows.map((r) => {
    const [table, enabled, forced] = r as [string, boolean, boolean];
    return { table, enabled, forced };
  });

  const policyResult = await driver.query(
    `select schemaname || '.' || tablename as t, policyname, permissive,
            array_to_string(roles, ', ') as roles, cmd, qual, with_check
     from pg_policies
     where schemaname not in (${SYSTEM})
     order by 1, policyname`,
  );
  const policies: Policy[] = policyResult.rows.map((r) => {
    const [table, name, permissive, roles, command, using, withCheck] = r as [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string | null,
    ];
    return { table, name, permissive, roles, command, using, withCheck };
  });

  const byTable = new Map<string, Policy[]>();
  for (const policy of policies) {
    byTable.set(policy.table, [...(byTable.get(policy.table) ?? []), policy]);
  }

  if (opts.table) {
    const wanted = opts.table.toLowerCase();
    const status =
      statuses.find((s) => s.table.toLowerCase() === wanted) ??
      statuses.find((s) => s.table.split(".").pop()?.toLowerCase() === wanted);
    if (!status) {
      throw new Error(`No table named "${opts.table}".`);
    }
    return detailFor(status, byTable.get(status.table) ?? []);
  }

  if (!statuses.length) return "No user tables found.";

  const rows = statuses.map((s) => {
    const count = (byTable.get(s.table) ?? []).length;
    return [
      s.table,
      s.enabled ? (s.forced ? "enabled (forced)" : "enabled") : "OFF",
      count,
      verdict(s, count),
    ];
  });

  const sections = [
    renderTable({
      columns: ["table", "rls", "policies", "note"],
      rows,
      rowCount: rows.length,
    }),
  ];

  const lockedOut = statuses.filter((s) => s.enabled && !(byTable.get(s.table) ?? []).length);
  const unprotected = statuses.filter((s) => !s.enabled);

  if (lockedOut.length) {
    sections.push(
      `⚠ RLS enabled with no policies — every row is denied to non-owner roles, ` +
        `including the anon and authenticated roles your client uses:\n` +
        lockedOut.map((s) => `  ${s.table}`).join("\n"),
    );
  }
  if (unprotected.length) {
    sections.push(
      `⚠ RLS off — no row filtering at all. Any role with table privileges reads every row:\n` +
        unprotected.map((s) => `  ${s.table}`).join("\n"),
    );
  }
  sections.push("Call db_policies with `table` to see a table's policy expressions.");

  return sections.join("\n\n");
}

function verdict(status: RlsStatus, policyCount: number): string {
  if (!status.enabled) return "unfiltered";
  if (policyCount === 0) return "DENIES ALL";
  return "";
}

function detailFor(status: RlsStatus, policies: Policy[]): string {
  const header = [
    status.table,
    `RLS: ${status.enabled ? (status.forced ? "enabled (forced — applies to the table owner too)" : "enabled") : "OFF"}`,
  ];

  if (!status.enabled) {
    header.push("No row filtering is applied. Every role with table privileges sees every row.");
    if (policies.length) {
      header.push(
        `${policies.length} policy definition${policies.length === 1 ? " exists" : "s exist"} but ${policies.length === 1 ? "is" : "are"} inert until RLS is enabled.`,
      );
    }
    return header.join("\n");
  }

  if (!policies.length) {
    header.push(
      "No policies are defined, so every row is denied to non-owner roles. Queries return empty rather than erroring.",
    );
    return header.join("\n");
  }

  const blocks = policies.map((p) => {
    const lines = [
      `— ${p.name}`,
      `  command:    ${p.command}`,
      `  roles:      ${p.roles || "(all)"}`,
      `  permissive: ${p.permissive}`,
    ];
    if (p.using) lines.push(`  USING:      ${p.using}`);
    if (p.withCheck) lines.push(`  WITH CHECK: ${p.withCheck}`);
    return lines.join("\n");
  });

  return `${header.join("\n")}\n\n${blocks.join("\n\n")}`;
}
