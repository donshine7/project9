import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertSafeTemplateRegistry,
  canonicalizeStatement,
  fingerprintEnvelope,
  fingerprintStatement,
  verifyTemplateEnvelope,
} from "../src/protocol/template-fingerprint.mjs";

const configuredRegistry = JSON.parse(
  readFileSync(new URL("../config/read-template-registry.json", import.meta.url), "utf8"),
);

function enabledRegistryFor(envelope) {
  return {
    schemaVersion: 1,
    algorithm: "sha256",
    templates: [{
      templateId: envelope.templateId,
      operation: "get-matter-detail",
      role: "main-matter-record",
      command: envelope.command,
      statementCount: envelope.statements.length,
      fingerprint: fingerprintEnvelope(envelope),
      enabled: true,
      status: "verified",
    }],
  };
}

test("canonicalization changes only BOM, line endings and outer whitespace", () => {
  assert.equal(canonicalizeStatement("\uFEFF  SELECT  a\r\nFROM view  "), "SELECT  a\nFROM view");
});

test("statement fingerprints are deterministic without exposing the statement", () => {
  const first = fingerprintStatement("SELECT a FROM allowed_view WHERE id = ?");
  const second = fingerprintStatement("SELECT a FROM allowed_view WHERE id = ?");
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("configured production registry enables only the three live-validated P261793 reads", () => {
  assert.equal(assertSafeTemplateRegistry(configuredRegistry), true);
  const enabled=configuredRegistry.templates.filter(item=>item.enabled===true);
  assert.equal(enabled.length,3);
  assert.deepEqual(enabled.map(item=>item.templateId),["matter-detail.main-record.v1","matter-detail.progress-records.v1","matter-detail.documents.v1"]);
  assert.ok(enabled.every(item=>item.boundMatterReference==="P261793"));
  assert.deepEqual(enabled.map(item=>item.responseVerification.mode),["statement-literal-equality","statement-literal-all-rows","statement-literal-all-rows"]);
  assert.ok(enabled.every(item=>/^[a-f0-9]{64}$/.test(item.fingerprint)));
  assert.ok(configuredRegistry.templates.filter(item=>item.enabled===false).every(item=>item.fingerprint===null));
});

test("verifies an exact allowlisted envelope", () => {
  const envelope = {
    templateId: "matter-detail.main-record.v1",
    command: "SELECT",
    statements: ["SELECT a FROM allowed_view WHERE id = ?"],
  };
  const result = verifyTemplateEnvelope(enabledRegistryFor(envelope), envelope);
  assert.equal(result.verified, true);
  assert.equal(result.rawStatementsIncluded, false);
  assert.ok(!Object.hasOwn(result, "statements"));
});

test("rejects a one-character difference from the registered template", () => {
  const registered = {
    templateId: "matter-detail.main-record.v1",
    command: "SELECT",
    statements: ["SELECT a FROM allowed_view WHERE id = ?"],
  };
  const changed = { ...registered, statements: ["SELECT b FROM allowed_view WHERE id = ?"] };
  assert.throws(
    () => verifyTemplateEnvelope(enabledRegistryFor(registered), changed),
    /fingerprint does not match/,
  );
});

test("rejects enabling a template without a fingerprint", () => {
  const invalid = structuredClone(configuredRegistry);
  invalid.templates[0].enabled = true;
  assert.throws(() => assertSafeTemplateRegistry(invalid), /require a SHA-256 fingerprint/);
});

test("rejects raw query text fields in the registry", () => {
  const invalid = structuredClone(configuredRegistry);
  invalid.templates[0].sqlText = "SELECT secret";
  assert.throws(() => assertSafeTemplateRegistry(invalid), /must not contain raw query text/);
});
