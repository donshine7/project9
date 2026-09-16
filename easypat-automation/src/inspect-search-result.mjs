import { createHash } from "node:crypto";
import { parseResultset } from "./protocol/resultset.mjs";
const chunks = [];
let size = 0;
try {
  for await (const c of process.stdin) { size += c.length; if (size > 2 * 1024 * 1024) throw new Error("too large"); chunks.push(c); }
  const { columns, rows } = parseResultset(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const ref = columns.find(c => c.toLowerCase() === "ourref");
  const key = columns.find(c => c.toLowerCase() === "idx");
  if (rows.length !== 1 || !key || !ref || rows[0][ref] !== "P261793" || !/^\d+$/.test(rows[0][key] ?? "")) throw new Error("unexpected search row");
  console.log(JSON.stringify({sessionId:119, exactReference:true, rowCount:1, searchField:key,
    valueDigest:createHash("sha256").update(rows[0][key], "utf8").digest("hex"),
    columns, executable:false}));
} catch {
  console.error('{"status":"rejected","reason":"invalid or masked search result","executable":false}'); process.exitCode=1;
} finally { chunks.forEach(c=>c.fill(0)); }
