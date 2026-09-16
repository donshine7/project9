import { fingerprintEnvelope } from "./protocol/template-fingerprint.mjs";
import { createReadOnlyBatch } from "./protocol/read-only-guard.mjs";

// One-time capture inspection only: accepts a copied SQL field via stdin.
// Session identity comes from the observed Fiddler UI, not from clipboard text.
const templates = {
  "168": "matter-detail.main-record.v1",
  "170": "matter-detail.related-counts.v1",
  "174": "matter-detail.progress-records.v1",
  "247": "matter-detail.documents.v1",
};
const sessionId = process.argv[2];
const chunks = [];
let size = 0;
try {
  if (!Object.hasOwn(templates, sessionId)) throw new Error("unknown capture");
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("input too large");
    chunks.push(chunk);
  }
  const sql = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  if (/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i.test(sql)) throw new Error("masked input");
  const envelope = { templateId: templates[sessionId], command: "SELECT", statements: [sql] };
  createReadOnlyBatch([envelope]);
  console.log(JSON.stringify({
    sessionId: Number(sessionId),
    templateId: envelope.templateId,
    command: "SELECT",
    statementCount: 1,
    candidateFingerprint: fingerprintEnvelope(envelope),
    containsExpectedReference: /'P261793'/i.test(sql),
    classification: "read-only-candidate",
    provenance: "Fiddler Form-Data SQL Copy Value, UI-observed session",
    executable: false,
    scope: "exact-captured-request-only",
    rawStatementsStored: false,
  }));
} catch {
  console.error(JSON.stringify({ status: "rejected", reason: "invalid, masked, or non-read copied statement", executable: false }));
  process.exitCode = 1;
} finally {
  chunks.forEach(chunk => chunk.fill(0));
}
