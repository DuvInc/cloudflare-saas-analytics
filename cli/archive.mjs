import { DuckDBInstance } from "@duckdb/node-api";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { deployment } from "./config.mjs";

export const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
export const tables = ["days", "people", "identities", "payments", "replay_sessions", "runs", "traffic_days", "delivery_days"];
export function tableSchemas(root) {
  const schema = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(path.join(root, "migrations")).filter((file) => file.endsWith(".sql")).sort()) schema.exec(readFileSync(path.join(root, "migrations", file), "utf8"));
    return Object.fromEntries(tables.map((table) => [table, schema.prepare(`PRAGMA table_info(${table})`).all().map((column) => [column.name, /INT/i.test(column.type) ? "BIGINT" : /REAL|FLOAT|DOUBLE/i.test(column.type) ? "DOUBLE" : "VARCHAR"])]));
  } finally { schema.close(); }
}
export function credentials(root) {
  const file = path.join(root, ".env");
  if (!existsSync(file)) throw new Error("Missing .env: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (remote reads only).");
  const values = Object.fromEntries(readFileSync(file, "utf8").split(/\r?\n/).filter((line) => /^\s*(?:export\s+)?[A-Z0-9_]+=/.test(line)).map((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    return [match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2")];
  }));
  if (!values.R2_ACCESS_KEY_ID || !values.R2_SECRET_ACCESS_KEY) throw new Error("Missing R2 read credentials");
  return values;
}
export async function connectArchive({ root, cache, live = false, remote = false }) {
  const db = await (await DuckDBInstance.create(":memory:")).connect();
  await db.run("SET TimeZone = 'UTC'");
  const types = { int64: "BIGINT", string: "VARCHAR", bool: "BOOLEAN", float64: "DOUBLE" };
  const fields = JSON.parse(readFileSync(path.join(root, "schema/stream.json"), "utf8")).fields.map((field) => [field.name, types[field.type]]);
  const columns = `{${fields.map(([name, type]) => `${name}: '${type}'`).join(", ")}}`;
  if (live || remote) {
    const values = credentials(root);
    await db.run(`CREATE SECRET r2 (TYPE R2, KEY_ID ${quote(values.R2_ACCESS_KEY_ID)}, SECRET ${quote(values.R2_SECRET_ACCESS_KEY)}, ACCOUNT_ID ${quote(deployment().account)})`);
  }
  const files = existsSync(path.join(cache, "events")) ? readdirSync(path.join(cache, "events")).filter((file) => file.endsWith(".parquet")) : [];
  const parts = files.length ? [`SELECT * FROM read_parquet(${quote(path.join(cache, "events", "*.parquet"))}, union_by_name = true)`] : [];
  if (live) {
    const count = (await db.runAndReadAll(`SELECT count(*) AS n FROM glob('r2://${deployment().bucket}/raw/**')`)).getRowObjects()[0].n;
    if (Number(count)) parts.push(`SELECT * FROM read_json('r2://${deployment().bucket}/raw/**', format = 'newline_delimited', columns = ${columns}) WHERE received_at >= epoch_ms(date_trunc('day', current_timestamp)) AND received_at <= epoch_ms(current_timestamp)`);
  }
  const empty = `SELECT ${fields.map(([name, type]) => `NULL::${type} AS ${name}`).join(", ")} WHERE false`;
  await db.run(`CREATE VIEW events AS ${parts.length ? parts.join(" UNION ALL BY NAME ") : empty}`);
  for (const [table, fields] of Object.entries(tableSchemas(root))) {
    const file = path.join(cache, "d1", `${table}.json`);
    const nonempty = existsSync(file) && JSON.parse(readFileSync(file, "utf8")).length > 0;
    await db.run(`CREATE VIEW ${table} AS ${nonempty ? `SELECT * FROM read_json(${quote(file)}, columns = {${fields.map(([name, type]) => `${quote(name)}: '${type}'`).join(", ")}})` : `SELECT ${fields.map(([name, type]) => `NULL::${type} AS "${name}"`).join(", ")} WHERE false`}`);
  }
  for (const [name, kind] of [["ai_crawl", "crawl"], ["traffic_totals", "totals"]]) {
    const directory = path.join(cache, "bots", kind);
    const present = existsSync(directory) && readdirSync(directory).some((file) => file.endsWith(".parquet"));
    await db.run(`CREATE VIEW ${name} AS ${present ? `SELECT * FROM read_parquet(${quote(path.join(directory, "*.parquet"))}, union_by_name = true)` : "SELECT NULL::VARCHAR AS zone WHERE false"}`);
  }
  return db;
}
export async function rows(db, sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new Error("A SQL query is required");
  return (await db.runAndReadAll(sql)).getRowObjects();
}
export function table(values) {
  if (!values.length) { console.log("No rows."); return; }
  const keys = Object.keys(values[0]);
  const cell = (value) => String(value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value, (_, nested) => typeof nested === "bigint" ? nested.toString() : nested) : value).replace(/\|/g, "\\|").replace(/[\r\n]/g, " ");
  console.log(`| ${keys.join(" | ")} |\n| ${keys.map(() => "---").join(" | ")} |`);
  for (const row of values) console.log(`| ${keys.map((key) => cell(row[key])).join(" | ")} |`);
}
