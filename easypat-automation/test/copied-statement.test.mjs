import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";

const cli = fileURLToPath(new URL("../src/inspect-copied-statement.mjs", import.meta.url));
function inspect(id, input) {
  return spawnSync(process.execPath, [cli, id], { input, encoding: "utf8", timeout: 5000 });
}
test("copied SQL stays out of output, with canonical UTF-8 fingerprint", () => {
  const sql = "SELECT '테스트+값' WHERE 1=1\r\n";
  const result = inspect("168", sql);
  assert.equal(result.status, 0);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.candidateFingerprint, fingerprintEnvelope({templateId: "matter-detail.main-record.v1", command:"SELECT", statements:[sql]}));
  assert.equal(summary.executable, false);
  assert.equal(summary.containsExpectedReference, false);
  assert.doesNotMatch(result.stdout + result.stderr, /테스트|WHERE/);
});
test("rejects unknown sessions, mutations, masked input, and malformed UTF-8 without echoing input", () => {
  for (const [id, sql] of [
    ["172", "SELECT 'private-marker'"],
    ["168", "UPDATE sample SET value='private-marker'"],
    ["170", "SELECT '!!!sanitized!!! private-marker'"],
    ["170", "SELECT '***SANITIZED*** private-marker'"],
    ["168", Buffer.from([0xff])],
  ]) {
    const result = inspect(id, sql);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /private-marker|sample/);
  }
});
test("reference detection is evidence only and does not enable execution", () => {
  const result = inspect("170", "SELECT 'P261793'");
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.containsExpectedReference, true);
  assert.equal(summary.executable, false);
});

test("accepts the observed progress candidate only as non-executable fingerprint evidence", () => {
  const result=inspect("174","SELECT * FROM progress_example WHERE idx_parent = 'private-key'");
  assert.equal(result.status,0);
  const summary=JSON.parse(result.stdout);
  assert.equal(summary.templateId,"matter-detail.progress-records.v1");
  assert.equal(summary.executable,false);
  assert.doesNotMatch(result.stdout,/progress_example|private-key/);
});

test("accepts the observed document-list candidate only as non-executable fingerprint evidence",()=>{
  const result=inspect("247","SELECT * FROM document_example WHERE GRP_KEY = 'private-progress-key'");
  assert.equal(result.status,0);
  const summary=JSON.parse(result.stdout);
  assert.equal(summary.templateId,"matter-detail.documents.v1");
  assert.equal(summary.executable,false);
  assert.doesNotMatch(result.stdout,/document_example|private-progress-key/);
});
