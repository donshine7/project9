import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createGenericMatterSummaryClient } from "../src/protocol/generic-matter-summary-client.mjs";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";

const policy = JSON.parse(readFileSync(new URL("../config/safety-policy.json", import.meta.url), "utf8"));
const countEnvelope = { templateId: "matter-search.exact-count.v1", command: "SELECT", statements: ["SELECT count(*) AS recCount FROM matters WHERE ourref = 'P261793'"] };
const searchEnvelope = { templateId: "matter-search.exact-result.v1", command: "SELECT", statements: ["SELECT idx, ourref FROM matters WHERE ourref = 'P261793'"] };
const detailEnvelope = { templateId: "matter-detail.main-record.v1", command: "SELECT", statements: ["SELECT * FROM matters WHERE idx = '100'"] };
const columns = ["idx", "app_right", "app_kind", "app_div", "d_app", "n_app", "title_kor", "status"];
for (let index = columns.length; index < 205; index++) columns.push(`field_${String(index).padStart(3, "0")}`);
const templates = new Map([[countEnvelope.templateId, countEnvelope], [searchEnvelope.templateId, searchEnvelope], [detailEnvelope.templateId, detailEnvelope]]);
const registry = {
  productionEnabled: true,
  requiredDistinctNonBaselineMatterValidations: 2,
  completedDistinctNonBaselineMatterValidations: 2,
  authorizedNonBaselineMatterReferences: ["PT261129", "PT261130"],
  validatedNonBaselineMatterReferences: ["PT261129", "PT261130"],
  templates: [
    { templateId: countEnvelope.templateId, command: "SELECT", statementCount: 1, productionEnabled: true, baseFingerprint: fingerprintEnvelope(countEnvelope), parameterization: { mode: "single-literal-equality", source: "matter-reference", predicateColumn: "ourref", baseMatterReference: "P261793" }, responseCountColumn: "recCount", expectedResponseColumns: ["recCount"] },
    { templateId: searchEnvelope.templateId, command: "SELECT", statementCount: 1, productionEnabled: true, baseFingerprint: fingerprintEnvelope(searchEnvelope), parameterization: { mode: "single-literal-equality", source: "matter-reference", predicateColumn: "ourref", baseMatterReference: "P261793" }, responseMatterColumn: "ourref", responseIdentityColumn: "idx", expectedResponseColumns: ["idx", "ourref"] },
    { templateId: detailEnvelope.templateId, command: "SELECT", statementCount: 1, productionEnabled: true, baseFingerprint: fingerprintEnvelope(detailEnvelope), parameterization: { mode: "single-scalar-equality", source: "verified-search-identity", predicateColumn: "idx", sourceTemplateId: searchEnvelope.templateId, sourceColumn: "idx" }, responseVerification: { mode: "statement-literal-equality", predicateColumn: "idx", responseColumn: "idx" }, expectedResponseColumnsSource: "main-record-response-schema.json" },
  ],
};
const mainSchema = { templateId: detailEnvelope.templateId, columnCount: 205, columns, rawRowValuesStored: false };

function resultset(resultColumns, rows) {
  const line = (values) => values.join("\x01") + "\r\n";
  return line(resultColumns) + line(resultColumns.map(() => "char")) + line(resultColumns.map(() => "2048")) +
    line(resultColumns.map(() => "r")) + rows.map((row) => line(resultColumns.map((column) => `"${String(row[column] ?? "").replaceAll('"', '""')}"`))).join("");
}

test("production generic client performs the exact three-read chain and returns only the safe projection", async () => {
  const calls = [];
  const row = Object.fromEntries(columns.map((column) => [column, ""]));
  Object.assign(row, { idx: "901", app_right: "PATENT", app_kind: "NORMAL", app_div: "KR", d_app: "20260916", n_app: "10-0000", title_kor: "허용된 명칭", status: "진행" });
  const responses = [
    resultset(["recCount"], [{ recCount: "1" }]),
    resultset(["idx", "ourref"], [{ idx: "901", ourref: "PT261130" }]),
    resultset(columns, [row]),
  ];
  const client = createGenericMatterSummaryClient({
    policy,
    registry,
    mainSchema,
    loadTemplate: async (id) => structuredClone(templates.get(id)),
    getSessionCookie: async () => "JSESSIONID=fixture-only",
    transport: async (request) => {
      calls.push(request);
      return { status: 200, contentType: "text/resultset", text: responses[calls.length - 1] };
    },
  });
  const summary = await client.lookupSummary({ matterReference: "PT261130" });
  assert.equal(calls.length, 3);
  assert.equal(summary.matterReference, "PT261130");
  assert.equal(summary.titleKorean, "허용된 명칭");
  assert.equal(Object.keys(summary).length, 8);
  assert.doesNotMatch(JSON.stringify(summary), /901|idx|JSESSIONID/);
  assert.ok(calls.every((call) => new URLSearchParams(call.body).get("command") === "SELECT"));
});

test("generic client refuses incomplete validation and unsafe production policy at construction", () => {
  const common = { mainSchema, loadTemplate: async () => null, getSessionCookie: async () => "unused", transport: async () => null };
  assert.throws(() => createGenericMatterSummaryClient({ policy, registry: { ...registry, completedDistinctNonBaselineMatterValidations: 1 }, ...common }), /CONFIGURATION_REJECTED/);
  assert.throws(() => createGenericMatterSummaryClient({ policy: { ...policy, mutationOperationsEnabled: true }, registry, ...common }), /CONFIGURATION_REJECTED/);
});
