import test from "node:test";
import assert from "node:assert/strict";
import { extractCapturedEnvelope, inspectFiddlerCapture, unwrapFiddlerSession } from "../src/protocol/fiddler-capture.mjs";

function session(fields = { connection: "EASYPAT_S_SSPAT", count: "1", command: "SELECT", sql: "SELECT '한글+값'" }) {
  return { id: 1, method: "POST", statusCode: "200",
    url: "https://mssql2.easypnp.co.kr:8443/servlet/Jbori",
    requestHeaders: { cookie: "do-not-output" },
    requestBody: { mimeType: "application/x-www-form-urlencoded; charset=utf-8", isBase64: false, content: new URLSearchParams(fields).toString() },
    responseBody: { content: "private-response", mimeType: "text/resultset" } };
}

test("parses form encoding exactly once and omits private data in summaries", () => {
  const data = session();
  assert.deepEqual(extractCapturedEnvelope(data).statements, ["SELECT '한글+값'"]);
  const summary = inspectFiddlerCapture(data);
  assert.match(summary.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(summary.executable, false);
  assert.doesNotMatch(JSON.stringify(summary), /do-not-output|private-response|한글/);
});
test("ignores execution notices and rejects tool errors", () => {
  assert.throws(() => unwrapFiddlerSession({ content: [{ type: "text", text: "Error executing tool" }] }), /no structured session/);
  assert.throws(() => unwrapFiddlerSession({ isError: true, structuredContent: session() }), /retrieval failed/);
  assert.equal(unwrapFiddlerSession({ content: [{ type: "text", text: JSON.stringify(session()) }] }).id, 1);
});
test("classifies writes without fingerprinting or allowing execution", () => {
  const data = session({ connection: "EASYPAT_S_SSPAT", count: "1", command: "UPDATE", sql: "UPDATE sample SET value=1" });
  const result = inspectFiddlerCapture(data);
  assert.equal(result.classification, "blocked");
  assert.equal(result.fingerprint, null);
});
test("blocks SELECT INTO writes and remote data access", () => {
  for (const sql of ["SELECT value INTO new_table FROM sample", "SELECT * FROM OPENQUERY(remote, 'SELECT 1')"]) {
    const data = session({ connection: "EASYPAT_S_SSPAT", count: "1", command: "SELECT", sql });
    assert.equal(inspectFiddlerCapture(data).classification, "blocked");
  }
});
test("validates all members of indexed batches", () => {
  const data = session({ connection: "EASYPAT_S_SSPAT", count: "2", command: "OTHERS", sql0: "SELECT 1", sql1: "DELETE FROM sample" });
  assert.equal(inspectFiddlerCapture(data).classification, "blocked");
  data.requestBody.content = data.requestBody.content.replace("sql1=", "sql2=");
  assert.throws(() => extractCapturedEnvelope(data), /indexes/);
});
test("rejects duplicates, secrets, wrong endpoints, and redacted SQL", () => {
  for (const suffix of ["&sql=SELECT+2", "&password=secret"]) {
    const data = session(); data.requestBody.content += suffix;
    assert.throws(() => extractCapturedEnvelope(data), /duplicate|unexpected/);
  }
  const wrong = session(); wrong.url += "?other=1";
  assert.throws(() => extractCapturedEnvelope(wrong), /endpoint/);
  const masked = session(); masked.requestBody.content = masked.requestBody.content.replace(/sql=.*/, "sql=!!!sanitized!!!");
  assert.throws(() => extractCapturedEnvelope(masked), /sanitized/);
});
test("accepts base64 and rejects malformed encoding", () => {
  const data = session();
  data.requestBody.content = Buffer.from(data.requestBody.content).toString("base64");
  data.requestBody.isBase64 = true;
  assert.equal(extractCapturedEnvelope(data).command, "SELECT");
  data.requestBody.content = "???";
  assert.throws(() => extractCapturedEnvelope(data), /base64/);
  const malformed = session(); malformed.requestBody.content += "%ZZ";
  assert.throws(() => extractCapturedEnvelope(malformed), /percent encoding/);
});
