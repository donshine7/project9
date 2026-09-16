import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { assertSafeTemplateRegistry, fingerprintEnvelope } from "./template-fingerprint.mjs";

const SENSITIVE_INPUT_KEY = /^(authorization|cookie|set-cookie|password|session|token|secret)$/i;
const ALLOWED_ENVELOPE_KEYS = new Set(["command", "statements"]);

function assertNoSensitiveKeys(value, path = "input") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_INPUT_KEY.test(key)) {
      throw new Error(`sensitive authentication field is prohibited at ${path}`);
    }
    assertNoSensitiveKeys(nested, `${path}.${key}`);
  }
}

export function validateRegistrationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("registration input must be an object");
  }
  assertNoSensitiveKeys(input);
  const unexpected = Object.keys(input).filter((key) => !ALLOWED_ENVELOPE_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new Error("registration input contains unexpected fields");
  }
  if (!Array.isArray(input.statements) || input.statements.length === 0) {
    throw new Error("registration input requires captured statements");
  }
  return true;
}

export function registerTemplateFingerprint(registry, templateId, input) {
  assertSafeTemplateRegistry(registry);
  validateRegistrationInput(input);

  const current = registry.templates.find((item) => item.templateId === templateId);
  if (!current) throw new Error("template id is not registered");

  const envelope = { templateId, command: input.command, statements: input.statements };
  const [safe] = createReadOnlyBatch([envelope]);
  if (safe.command !== current.command || safe.statementCount !== current.statementCount) {
    throw new Error("captured request shape does not match the pending template");
  }

  const fingerprint = fingerprintEnvelope(envelope);
  if (current.enabled === true) {
    if (current.fingerprint !== fingerprint) {
      throw new Error("enabled template fingerprint cannot be replaced");
    }
    return {
      registry: structuredClone(registry),
      summary: {
        templateId,
        fingerprint,
        enabled: true,
        changed: false,
        rawStatementsStored: false,
      },
    };
  }

  const updated = structuredClone(registry);
  const target = updated.templates.find((item) => item.templateId === templateId);
  target.fingerprint = fingerprint;
  target.enabled = true;
  target.status = "verified";
  assertSafeTemplateRegistry(updated);

  return {
    registry: updated,
    summary: {
      templateId,
      fingerprint,
      enabled: true,
      changed: true,
      rawStatementsStored: false,
    },
  };
}
