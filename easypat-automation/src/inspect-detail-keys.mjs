import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { collectLiteralEqualities } from "./protocol/matter-linkage.mjs";
import { fingerprintEnvelope } from "./protocol/template-fingerprint.mjs";
const chunks = [];
let size = 0;
try {
  const candidates = JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json", import.meta.url))).candidates;
  const candidate = candidates.find(c=>String(c.sessionId)===process.argv[2] && c.command==="SELECT");
  if (!candidate) throw new Error("unknown candidate");
  for await (const c of process.stdin) { size += c.length; if(size>1024*1024)throw new Error("too large"); chunks.push(c); }
  const sql = new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  const digest = fingerprintEnvelope({templateId:candidate.templateId,command:"SELECT",statements:[sql]});
  if (digest!==candidate.fingerprint) throw new Error("stale or modified copy");
  const predicates = collectLiteralEqualities(sql).map(p=>({column:p.column,valueDigest:createHash("sha256").update(p.literal,"utf8").digest("hex")}));
  console.log(JSON.stringify({sessionId:candidate.sessionId,candidateFingerprint:digest,predicates,executable:false}));
} catch {
  console.error('{"status":"rejected","reason":"detail key inspection failed","executable":false}');process.exitCode=1;
} finally { chunks.forEach(c=>c.fill(0)); }
