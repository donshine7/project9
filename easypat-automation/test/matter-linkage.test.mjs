import test from "node:test";
import assert from "node:assert/strict";
import { inspectMatterLinkage } from "../src/protocol/matter-linkage.mjs";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";

function evidence(sql = "SELECT * FROM example WHERE app_id = 'private-id-123'", row = { OurRef: "P261793", app_id: "private-id-123" }) {
  return { matterReference: "P261793", searchRows: [row], detailSql: sql,
    candidate: { sessionId: 168, templateId: "test.detail", command: "SELECT", statementCount: 1,
      fingerprint: fingerprintEnvelope({templateId:"test.detail", command:"SELECT", statements:[sql]}) } };
}
test("reports field linkage without disclosing internal values or enabling execution", () => {
  const result = inspectMatterLinkage(evidence());
  assert.equal(result.status, "candidate-value-link-observed");
  assert.deepEqual(result.matches, [{searchField:"app_id", detailColumn:"app_id"}]);
  assert.equal(result.executable, false);
  assert.doesNotMatch(JSON.stringify(result), /private-id-123/);
});
test("requires exact full reference and a single row", () => {
  for (const ref of ["P261793-S1", "P261793-CN", "P261793-CN(PA)"]) {
    const input = evidence(); input.searchRows[0].OurRef = ref;
    assert.throws(() => inspectMatterLinkage(input), /exact matter/);
  }
  const input = evidence(); input.searchRows.push(input.searchRows[0]);
  assert.throws(() => inspectMatterLinkage(input), /exactly one/);
});
test("rejects stale clipboard SQL and masked SQL", () => {
  const input = evidence(); input.detailSql += " ";
  assert.equal(inspectMatterLinkage(input).captureFingerprintMatched, true);
  input.detailSql = input.detailSql.replace("123", "124");
  assert.throws(() => inspectMatterLinkage(input), /fingerprint mismatch/);
  input.detailSql = "SELECT '!!!sanitized!!!'";
  assert.throws(() => inspectMatterLinkage(input), /original detail/);
});
test("does not interpret text in comments or strings as equality predicates", () => {
  const input = evidence("SELECT 'app_id = ''private-id-123''' AS note /* app_id = 'private-id-123' */ FROM example");
  assert.equal(inspectMatterLinkage(input).status, "no-unambiguous-link");
});
test("leaves duplicate values ambiguous and preserves leading zero distinctions", () => {
  const input = evidence(); input.searchRows[0].other_id = "private-id-123";
  assert.equal(inspectMatterLinkage(input).ambiguousPredicates, 1);
  assert.equal(inspectMatterLinkage(input).matches.length, 0);
  const zeros = evidence("SELECT * FROM example WHERE app_id = '0012'", {OurRef:"P261793", app_id:12});
  assert.equal(inspectMatterLinkage(zeros).matches.length, 0);
});
test("handles bracketed qualified identifiers and escaped unicode strings", () => {
  const input = evidence("SELECT * FROM example WHERE e.[app_id] = N'값''123'", {OurRef:"P261793", app_id:"값'123"});
  assert.equal(inspectMatterLinkage(input).matches.length, 1);
});
test("does not match comparison fragments or arithmetic", () => {
  for (const sql of ["SELECT * FROM example WHERE app_id >= 123", "SELECT * FROM example WHERE app_id = 123 + 1"]) {
    assert.equal(inspectMatterLinkage(evidence(sql, {OurRef:"P261793", app_id:123})).matches.length, 0);
  }
});
