import { createHash } from "node:crypto";
import { createReadOnlyBatch } from "./read-only-guard.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RAW_TEXT_KEY_PATTERN = /(sql|statement|query)(text|value|raw|source)?$/i;

export function canonicalizeStatement(statement) {
  if (typeof statement !== "string" || !statement.trim()) {
    throw new Error("a non-empty statement is required for fingerprinting");
  }
  return statement.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

export function fingerprintStatement(statement) {
  return createHash("sha256").update(canonicalizeStatement(statement), "utf8").digest("hex");
}

export function fingerprintEnvelope(envelope) {
  const [safe] = createReadOnlyBatch([envelope]);
  const material = JSON.stringify({
    command: safe.command,
    statementFingerprints: envelope.statements.map(fingerprintStatement),
  });
  return createHash("sha256").update(material, "utf8").digest("hex");
}

export function assertSafeTemplateRegistry(registry) {
  if (registry?.algorithm !== "sha256" || !Array.isArray(registry.templates)) {
    throw new Error("invalid template registry");
  }
  const ids = new Set();
  for (const template of registry.templates) {
    if (!template.templateId || ids.has(template.templateId)) {
      throw new Error("template ids must be present and unique");
    }
    ids.add(template.templateId);
    for (const key of Object.keys(template)) {
      if (RAW_TEXT_KEY_PATTERN.test(key)) {
        throw new Error("template registry must not contain raw query text");
      }
    }
    if (template.enabled === true && !SHA256_PATTERN.test(template.fingerprint ?? "")) {
      throw new Error("enabled templates require a SHA-256 fingerprint");
    }
    if (template.enabled !== true && template.fingerprint != null) {
      throw new Error("disabled templates must not retain an active fingerprint");
    }
  }
  return true;
}

export function verifyTemplateEnvelope(registry, envelope) {
  assertSafeTemplateRegistry(registry);
  const template = registry.templates.find((item) => item.templateId === envelope?.templateId);
  if (!template) throw new Error("captured request has no registered template id");
  if (template.enabled !== true) throw new Error("template is not enabled");

  const [safe] = createReadOnlyBatch([envelope]);
  if (safe.command !== template.command || safe.statementCount !== template.statementCount) {
    throw new Error("captured request shape does not match the registered template");
  }
  const actualFingerprint = fingerprintEnvelope(envelope);
  if (actualFingerprint !== template.fingerprint) {
    throw new Error("captured request fingerprint does not match the registered template");
  }

  return Object.freeze({
    verified: true,
    templateId: template.templateId,
    operation: template.operation,
    role: template.role,
    command: template.command,
    statementCount: template.statementCount,
    fingerprint: actualFingerprint,
    rawStatementsIncluded: false,
  });
}
