import { parse, toSql, type Statement, type Expr, type QName } from "pgsql-ast-parser";
import { assertReadOnlySql } from "@dryrun/core";

export type Target =
  | { kind: "delete" | "update"; table: QName; alias?: string; where?: Expr; whereSql?: string; allRows: boolean; hasUsing: boolean; hasParams: boolean; returning: boolean; stmtSql?: string }
  | { kind: "truncate"; tables: QName[]; cascade: boolean }
  | { kind: "drop"; what: string; names: QName[]; cascade: boolean }
  | { kind: "dropColumn"; table: QName; column: string }
  | { kind: "alter"; table: QName; change: string }
  | { kind: "insert"; table: QName }
  | { kind: "select"; benign: boolean }
  | { kind: "other"; type: string }
  | { kind: "unparsed"; text: string; hint?: string };

export const qn = (t: QName) => `${t.schema ?? "public"}.${t.name}`;
export const qident = (t: QName) => `"${(t.schema ?? "public").replace(/"/g, '""')}"."${t.name.replace(/"/g, '""')}"`;

function isConstTrue(e?: Expr): boolean {
  if (!e) return true;
  if (e.type === "boolean") return e.value === true;
  if (e.type === "binary" && e.op === "=" && e.left.type === "integer" && e.right.type === "integer") return e.left.value === e.right.value;
  return false;
}

export function analyzeSql(sql: string): Target[] {
  let stmts: Statement[];
  try { stmts = parse(sql); }
  catch (e) {
    const hint = /\bdrop\s+(database|schema|table|owned)\b/i.test(sql) ? "contains DROP" : /\b(truncate|delete)\b/i.test(sql) ? "contains TRUNCATE/DELETE" : undefined;
    return [{ kind: "unparsed", text: sql, hint: hint ?? (e as Error).message.split("\n")[0] }];
  }
  if (stmts.length === 0) return [{ kind: "unparsed", text: sql, hint: "empty statement" }];
  const out: Target[] = [];
  for (const s of stmts) {
    switch (s.type) {
      case "delete": case "update": {
        const table = s.type === "delete" ? s.from : s.table;
        const where = s.where ?? undefined;
        let whereSql: string | undefined; let hasParams = false;
        if (where) { whereSql = toSql.expr(where); hasParams = /\$\d+/.test(whereSql); }
        out.push({ kind: s.type, table: { schema: table.schema, name: table.name }, alias: table.alias, where, whereSql, allRows: isConstTrue(where), hasUsing: "using" in s && !!(s as { using?: unknown }).using, hasParams, returning: !!(s as { returning?: unknown }).returning, stmtSql: safeSql(s) });
        break;
      }
      case "truncate table": out.push({ kind: "truncate", tables: s.tables, cascade: s.cascade === "cascade" }); break;
      case "insert": out.push({ kind: "insert", table: { schema: s.into.schema, name: s.into.name } }); break;
      case "alter table": {
        for (const c of s.changes) {
          if (c.type === "drop column") out.push({ kind: "dropColumn", table: s.table, column: c.column.name });
          else out.push({ kind: "alter", table: s.table, change: c.type });
        }
        if (!s.changes.length) out.push({ kind: "alter", table: s.table, change: "unknown" });
        break;
      }
      case "select": case "with": case "union": case "union all": case "values": case "show": case "with recursive":
      case "explain" as never: {
        let benign = false;
        try { assertReadOnlySql(sql); benign = true; } catch { benign = false; }
        out.push({ kind: "select", benign });
        break;
      }
      default: {
        if (s.type.startsWith("drop")) {
          const names = ("names" in s ? (s as unknown as { names: QName[] }).names : []) ?? [];
          out.push({ kind: "drop", what: s.type.replace("drop ", ""), names, cascade: (s as { cascade?: string }).cascade === "cascade" });
        } else out.push({ kind: "other", type: s.type });
      }
    }
  }
  return out;
}

function safeSql(s: Statement): string | undefined {
  try { return toSql.statement(s); } catch { return undefined; }
}
