import { readFileSync } from "node:fs";
import { inspectMatterLinkage } from "./protocol/matter-linkage.mjs";

const chunks = [];
let bytes = 0;
try {
  const registry = JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json", import.meta.url), "utf8"));
  const candidate = registry.candidates.find(c => String(c.sessionId) === process.argv[2]);
  if (!candidate || candidate.command !== "SELECT") throw new Error("unknown candidate");
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("input too large");
    chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  if (!input || Object.keys(input).some(k => !["matterReference", "searchRows", "detailSql"].includes(k))) throw new Error("unexpected fields");
  console.log(JSON.stringify(inspectMatterLinkage({ ...input, candidate })));
} catch {
  console.error(JSON.stringify({ status: "rejected", reason: "linkage evidence is incomplete, mismatched, or unsupported", executable: false }));
  process.exitCode = 1;
} finally {
  chunks.forEach(chunk => chunk.fill(0));
}
