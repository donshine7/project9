import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertReadOnlyStatement,
  createReadOnlyBatch,
  planMatterDetailIsolation,
  summarizeCapturedEnvelope,
} from "../src/protocol/read-only-guard.mjs";

const detailObservation = JSON.parse(
  readFileSync(new URL("../config/protocol-observations/matter-detail-entry.json", import.meta.url), "utf8"),
);

test("accepts a fixed SELECT template", () => {
  assert.equal(assertReadOnlyStatement("SELECT value FROM allowed_view WHERE id = ?"), true);
});

test("accepts a read-only CTE", () => {
  assert.equal(assertReadOnlyStatement("WITH x AS (SELECT 1 AS n) SELECT n FROM x"), true);
});

test("rejects every mutation and execution family", () => {
  for (const statement of [
    "UPDATE allowed_view SET value = ?",
    "INSERT INTO allowed_view(value) VALUES (?)",
    "DELETE FROM allowed_view WHERE id = ?",
    "MERGE allowed_view USING source ON 1=1 WHEN MATCHED THEN UPDATE SET value=1",
    "EXEC dangerous_procedure",
    "WITH x AS (SELECT 1) DELETE FROM allowed_view",
  ]) {
    assert.throws(() => assertReadOnlyStatement(statement), /forbidden|not an allowlisted/);
  }
});

test("rejects a mixed batch without producing a partial executable plan", () => {
  assert.throws(
    () => createReadOnlyBatch([
      { templateId: "matter-main", command: "SELECT", statements: ["SELECT * FROM allowed_view"] },
      { templateId: "automatic-status-write", command: "UPDATE", statements: ["UPDATE allowed_view SET value=1"] },
    ]),
    /non-read command/,
  );
});

test("permits a validated multi-read envelope but omits raw statements from summaries", () => {
  const envelope = {
    templateId: "reference-codes",
    command: "OTHERS",
    statements: ["SELECT a FROM allowed_view", "SELECT b FROM allowed_view"],
  };
  const batch = createReadOnlyBatch([envelope]);
  assert.equal(batch[0].statementCount, 2);
  assert.deepEqual(summarizeCapturedEnvelope(envelope), {
    templateId: "reference-codes",
    command: "OTHERS",
    statementCount: 2,
    classification: "read-only-candidate",
    rawStatementsIncluded: false,
  });
});

test("detail isolation remains blocked while the captured navigation batch contains a write", () => {
  const plan = planMatterDetailIsolation(detailObservation);
  assert.equal(plan.status, "blocked");
  assert.equal(plan.reason, "captured-navigation-batch-contains-write");
  assert.ok(plan.candidateReadRoles.includes("main-matter-record"));
  assert.deepEqual(plan.excludedWriteRoles, ["automatic-status-write"]);
  assert.equal(plan.executableBatch, null);
});
