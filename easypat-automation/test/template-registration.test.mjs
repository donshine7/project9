import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  registerTemplateFingerprint,
  validateRegistrationInput,
} from "../src/protocol/template-registration.mjs";
import { verifyTemplateEnvelope } from "../src/protocol/template-fingerprint.mjs";

const configuredRegistry = JSON.parse(
  readFileSync(new URL("../config/read-template-registry.json", import.meta.url), "utf8"),
);
const pendingRegistry=structuredClone(configuredRegistry);
const pendingMain=pendingRegistry.templates.find(item=>item.templateId==="matter-detail.main-record.v1");
pendingMain.enabled=false;pendingMain.fingerprint=null;pendingMain.status="pending-test-registration";

const safeInput = {
  command: "SELECT",
  statements: ["SELECT a FROM allowed_view WHERE id = ?"],
};

test("registers only the fingerprint and never the captured statement", () => {
  const { registry, summary } = registerTemplateFingerprint(
    pendingRegistry,
    "matter-detail.main-record.v1",
    safeInput,
  );
  const stored = registry.templates.find((item) => item.templateId === summary.templateId);
  assert.equal(stored.enabled, true);
  assert.match(stored.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(summary.rawStatementsStored, false);
  assert.doesNotMatch(JSON.stringify(registry), /allowed_view/);

  const verified = verifyTemplateEnvelope(registry, {
    templateId: summary.templateId,
    ...safeInput,
  });
  assert.equal(verified.verified, true);
});

test("rejects authentication material before registration", () => {
  assert.throws(
    () => validateRegistrationInput({ ...safeInput, cookie: "secret" }),
    /sensitive authentication field/,
  );
});

test("rejects unexpected metadata to keep the input surface minimal", () => {
  assert.throws(
    () => validateRegistrationInput({ ...safeInput, url: "https://example.invalid" }),
    /unexpected fields/,
  );
});

test("rejects a mutation without changing the original registry", () => {
  const before = JSON.stringify(configuredRegistry);
  assert.throws(
    () => registerTemplateFingerprint(
      configuredRegistry,
      "matter-detail.main-record.v1",
      { command: "UPDATE", statements: ["UPDATE allowed_view SET a = 1"] },
    ),
    /non-read command/,
  );
  assert.equal(JSON.stringify(configuredRegistry), before);
});

test("rejects the wrong command or statement count for a known template", () => {
  assert.throws(
    () => registerTemplateFingerprint(
      configuredRegistry,
      "matter-detail.reference-codes.v1",
      safeInput,
    ),
    /shape does not match/,
  );
});

test("an enabled fingerprint is immutable but same-input registration is idempotent", () => {
  const first = registerTemplateFingerprint(
    pendingRegistry,
    "matter-detail.main-record.v1",
    safeInput,
  );
  const same = registerTemplateFingerprint(first.registry, "matter-detail.main-record.v1", safeInput);
  assert.equal(same.summary.changed, false);
  assert.throws(
    () => registerTemplateFingerprint(first.registry, "matter-detail.main-record.v1", {
      command: "SELECT",
      statements: ["SELECT b FROM allowed_view WHERE id = ?"],
    }),
    /cannot be replaced/,
  );
});
