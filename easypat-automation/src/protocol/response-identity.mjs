import { collectLiteralEqualities } from "./matter-linkage.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MASK = /!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

// Compiles one response identity from an already fingerprinted fixed statement.
// The internal literal stays in memory and is never included in the result or errors.
export function compilePredicateResponseIdentity(statement, verification) {
  if (!verification || Object.keys(verification).sort().join(",") !== "mode,predicateColumn,responseColumn") {
    throw new Error("invalid response identity policy");
  }
  if (!["statement-literal-equality","statement-literal-all-rows"].includes(verification.mode) ||
      !NAME.test(verification.predicateColumn ?? "") ||
      !NAME.test(verification.responseColumn ?? "")) {
    throw new Error("invalid response identity policy");
  }
  const matches = collectLiteralEqualities(statement).filter(
    item => item.column.toLowerCase() === verification.predicateColumn.toLowerCase(),
  );
  if (matches.length !== 1 || typeof matches[0].literal !== "string" ||
      !matches[0].literal.length || matches[0].literal.length > 1024 || MASK.test(matches[0].literal)) {
    throw new Error("fixed statement has no unique response identity");
  }
  return Object.freeze({
    mode: verification.mode,
    responseColumn: verification.responseColumn,
    expectedValue: matches[0].literal,
  });
}

export function verifyPredicateResponseIdentity(result, binding) {
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows) ||
      !binding || !["statement-literal-equality","statement-literal-all-rows"].includes(binding.mode) ||
      !NAME.test(binding.responseColumn ?? "") || typeof binding.expectedValue !== "string") {
    throw new Error("response identity mismatch");
  }
  const columns = result.columns.filter(
    column => column.toLowerCase() === binding.responseColumn.toLowerCase(),
  );
  const rowCountOk=binding.mode==="statement-literal-equality"?result.rows.length===1:result.rows.length>0;
  if (columns.length !== 1 || !rowCountOk || result.rows.some(row=>row[columns[0]]!==binding.expectedValue)) {
    throw new Error("response identity mismatch");
  }
  return Object.freeze({ verified: true, responseColumn: columns[0], rowCount:result.rows.length, rawIdentityIncluded: false });
}
