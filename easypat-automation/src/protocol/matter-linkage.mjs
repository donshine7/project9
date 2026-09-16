import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { fingerprintEnvelope } from "./template-fingerprint.mjs";

const MASK = /!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// This is a conservative tokenizer for evidence collection, not an SQL executor.
// It never substitutes values or declares a query safe to execute on another case.
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    let match;
    if ((match = /^\s+/.exec(rest))) { i += match[0].length; continue; }
    if (rest.startsWith("--")) {
      const end = rest.search(/[\r\n]/);
      i += end < 0 ? rest.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      if (end < 0 || rest.slice(2, end).includes("/*")) throw new Error("unsupported SQL comment");
      i += end + 2; continue;
    }
    if ((match = /^(?:N)?'((?:[^']|'')*)'/i.exec(rest))) {
      tokens.push({ kind: "literal", value: match[1].replace(/''/g, "'") });
      i += match[0].length; continue;
    }
    if ((match = /^\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(rest))) {
      tokens.push({ kind: "identifier", value: match[1] }); i += match[0].length; continue;
    }
    if ((match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      tokens.push({ kind: "identifier", value: match[0] }); i += match[0].length; continue;
    }
    if ((match = /^\d+(?![\w.])/.exec(rest))) {
      tokens.push({ kind: "literal", value: match[0] }); i += match[0].length; continue;
    }
    if (/[\s.,=()<>+*/;%-]/.test(rest[0])) {
      tokens.push({ kind: "symbol", value: rest[0] }); i += 1; continue;
    }
    throw new Error("unsupported SQL token in linkage evidence");
  }
  return tokens;
}

function scalar(value) {
  if (typeof value === "string" && value.length > 0 && !MASK.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

export function collectLiteralEqualities(detailSql) {
  const tokens = tokenize(detailSql);
  const predicates = [];
  for (let i = 1; i < tokens.length - 1; i++) {
    if (tokens[i].value !== "=" || tokens[i].kind !== "symbol") continue;
    if (["<", ">", "!", "="].includes(tokens[i - 1]?.value)) continue;
    const left = tokens[i - 1], right = tokens[i + 1];
    if (left.kind !== "identifier" || right.kind !== "literal") continue;
    const next = tokens[i + 2];
    if (next && !(next.kind === "symbol" && [")", ";"].includes(next.value)) &&
        !(next.kind === "identifier" && /^(AND|OR|ORDER|GROUP|HAVING|UNION|FOR|OPTION)$/i.test(next.value))) continue;
    predicates.push({ column: left.value, literal: right.value });
  }
  return predicates;
}

export function inspectMatterLinkage({ matterReference, searchRows, detailSql, candidate }) {
  if (typeof matterReference !== "string" || !/^[A-Za-z0-9()_-]+$/.test(matterReference)) {
    throw new Error("a full matter reference is required");
  }
  if (!Array.isArray(searchRows) || searchRows.length !== 1) throw new Error("exactly one search row is required");
  const row = searchRows[0];
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid search row");
  const refFields = Object.keys(row).filter(key => key.toLowerCase() === "ourref");
  if (refFields.length !== 1 || row[refFields[0]] !== matterReference) {
    throw new Error("search row does not match the exact matter reference");
  }
  if (typeof detailSql !== "string" || detailSql.length > 1024 * 1024 || MASK.test(detailSql)) {
    throw new Error("original detail SQL is required");
  }
  if (candidate?.command !== "SELECT" || candidate.statementCount !== 1 || !candidate.templateId) {
    throw new Error("unsupported captured detail candidate");
  }
  const envelope = { templateId: candidate.templateId, command: "SELECT", statements: [detailSql] };
  createReadOnlyBatch([envelope]);
  if (fingerprintEnvelope(envelope) !== candidate.fingerprint) throw new Error("detail capture fingerprint mismatch");

  const predicates = collectLiteralEqualities(detailSql);
  const matches = [];
  let ambiguousPredicates = 0;
  for (const predicate of predicates) {
    const fields = Object.keys(row).filter(key => NAME.test(key) && key !== refFields[0] && scalar(row[key]) === predicate.literal);
    if (fields.length > 1) { ambiguousPredicates++; continue; }
    if (fields.length === 1) matches.push({ searchField: fields[0], detailColumn: predicate.column });
  }
  const uniqueMatches = [...new Map(matches.map(m => [JSON.stringify(m), m])).values()];
  return {
    status: uniqueMatches.length ? "candidate-value-link-observed" : "no-unambiguous-link",
    matterReference,
    sessionId: candidate.sessionId,
    templateId: candidate.templateId,
    captureFingerprintMatched: true,
    matches: uniqueMatches,
    ambiguousPredicates,
    executable: false,
    internalValuesIncluded: false,
    limitation: "One captured value match does not establish primary-key semantics or authorize parameter substitution.",
  };
}
