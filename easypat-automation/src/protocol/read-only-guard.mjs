const ALLOWED_COMMANDS = new Set(["SELECT", "OTHERS"]);
const FORBIDDEN_SQL_TOKEN = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|EXEC(?:UTE)?|CALL|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|INTO|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i;

function normalizeCommand(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function assertReadOnlyStatement(statement) {
  if (typeof statement !== "string" || !statement.trim()) {
    throw new Error("a non-empty captured statement is required");
  }

  const normalized = statement
    .replace(/^\uFEFF/, "")
    .replace(/^(?:\s|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .trim();

  if (FORBIDDEN_SQL_TOKEN.test(normalized)) {
    throw new Error("captured statement contains a forbidden mutation or execution token");
  }
  if (!/^(SELECT|WITH)\b/i.test(normalized)) {
    throw new Error("captured statement is not an allowlisted read query");
  }
  return true;
}

export function createReadOnlyBatch(envelopes) {
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    throw new Error("at least one captured request envelope is required");
  }

  const batch = envelopes.map((envelope, index) => {
    const command = normalizeCommand(envelope?.command);
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`request ${index + 1} uses a non-read command`);
    }
    if (!Array.isArray(envelope.statements) || envelope.statements.length === 0) {
      throw new Error(`request ${index + 1} has no captured statements`);
    }
    envelope.statements.forEach(assertReadOnlyStatement);

    return Object.freeze({
      templateId: String(envelope.templateId ?? "").trim(),
      command,
      statementCount: envelope.statements.length,
      mutates: false,
    });
  });

  if (batch.some((item) => !item.templateId)) {
    throw new Error("every read request requires a stable internal template id");
  }
  return Object.freeze(batch);
}

export function summarizeCapturedEnvelope(envelope) {
  const command = normalizeCommand(envelope?.command);
  const statements = Array.isArray(envelope?.statements) ? envelope.statements : [];
  let classification = "blocked";
  try {
    createReadOnlyBatch([{ ...envelope, templateId: envelope?.templateId ?? "inspection" }]);
    classification = "read-only-candidate";
  } catch {
    classification = "blocked";
  }

  return {
    templateId: String(envelope?.templateId ?? "").trim() || undefined,
    command,
    statementCount: statements.length,
    classification,
    rawStatementsIncluded: false,
  };
}

export function planMatterDetailIsolation(observation) {
  const reads = observation.notableResponses
    .filter((item) => ["read-only-select", "multi-read"].includes(item.commandClass))
    .map((item) => item.role);
  const writes = observation.notableResponses
    .filter((item) => item.commandClass === "write-update")
    .map((item) => item.role);

  return {
    status: writes.length > 0 ? "blocked" : "ready-for-template-validation",
    reason: writes.length > 0 ? "captured-navigation-batch-contains-write" : null,
    candidateReadRoles: reads,
    excludedWriteRoles: writes,
    executableBatch: null,
  };
}
