import { scanAuthenticationSql } from "./authentication-shape.mjs";

// Pinned to the locally observed session 32/sql1 structure, NOT arbitrary SQL.
const EXPECTED_SHAPE = "SELECT T1 . * , M1 . macad , M1 . pcname FROM opms_login_member T1 LEFT JOIN ( SELECT TOP <value> userid , macad , pcname FROM opms_login_macads WHERE userid = <value> ORDER BY r_date DESC ) M1 ON M1 . userid = T1 . id WHERE T1 . del_flag = <value> AND T1 . d_retire IS NULL AND T1 . ck_off = <value> AND T1 . div_use = <value> AND T1 . id = <value> AND T1 . pw = dbo . EncryptTxt ( <value> )";
const INPUT_SLOTS = [1, 5, 6];
const CONTROL_SLOTS = [0, 2, 3, 4];

function scanPinned(sql) {
  const scan = scanAuthenticationSql(sql);
  if (scan.commentCount || scan.literalCount !== 7 || scan.shape.toUpperCase() !== EXPECTED_SHAPE.toUpperCase()) throw new Error();
  return scan;
}
function stringLiteral(raw) {
  const match = /^(N?)'((?:[^']|'')*)'$/i.exec(raw);
  if (!match) throw new Error();
  return {prefix: match[1], value: match[2].replaceAll("''", "'")};
}
function credential(value, limit) {
  // Encoding/collation for non-ASCII credentials has not yet been established.
  if (typeof value !== "string" || !value.length || value.length > limit || /[^\x20-\x7e]/.test(value)) throw new Error();
  return value;
}

// Separate closure: receives only credential-free fragments and fixed constants.
function makeBinder(parts, prefixes, controlLiterals) {
  function bind(input) {
    try {
      if (!input || Object.keys(input).sort().join(",") !== "password,username") throw new Error();
      const username = credential(input.username, 128), password = credential(input.password, 256);
      const values = [username, username, password];
      const sql = parts.map((part, i) => part + (i < 3 ? prefixes[i] + "'" + values[i].replaceAll("'", "''") + "'" : "")).join("");
      const scan = scanPinned(sql);
      if (CONTROL_SLOTS.some((slot, i) => scan.literalSpans[slot].raw !== controlLiterals[i]) ||
          INPUT_SLOTS.some((slot, i) => stringLiteral(scan.literalSpans[slot].raw).value !== values[i])) throw new Error();
      return sql; // Secret-bearing: trusted adapter memory only, never logs/tool output.
    } catch { throw new Error("AUTH_BINDING_REJECTED"); }
  }
  return Object.freeze({bind, summary: Object.freeze({
    status:"binding-compiled", usernameSlotCount:2, passwordSlotCount:1,
    fixedLiteralCount:4, originalCredentialsRetainedInTemplate:false,
    networkEnabled:false, authenticationVerified:false, executable:false,
  })});
}

export function compileAuthenticationBinding(sql) {
  try {
    const scan = scanPinned(sql);
    const inputs = INPUT_SLOTS.map(slot => stringLiteral(scan.literalSpans[slot].raw));
    if (inputs[0].value !== inputs[1].value) throw new Error();
    credential(inputs[0].value, 128); credential(inputs[2].value, 256);
    // Preserve, never guess, the captured TOP and account-status constants.
    if (!/^[1-9]\d*$/.test(scan.literalSpans[0].raw)) throw new Error();
    for (const slot of [2, 3, 4]) stringLiteral(scan.literalSpans[slot].raw);
    const parts = [];
    let cursor = 0;
    for (const slot of INPUT_SLOTS) {
      const span = scan.literalSpans[slot];
      parts.push(sql.slice(cursor, span.start)); cursor = span.end;
    }
    parts.push(sql.slice(cursor));
    // Do not retain a captured credential repeated in an unclassified location.
    if (parts.some(p => inputs.some(input => p.includes(input.value)))) throw new Error();
    return makeBinder(parts, inputs.map(i => i.prefix), CONTROL_SLOTS.map(slot => scan.literalSpans[slot].raw));
  } catch { throw new Error("AUTH_TEMPLATE_REJECTED"); }
}

// Only assesses a projected identity row, not the raw 44-column response.
// Empty/mismatched rows are not labeled "wrong password": failure semantics unknown.
export function assessLoginIdentity({ids, schemaMatched} = {}, expectedUsername) {
  let status = "unverified-response";
  if (schemaMatched === true && typeof expectedUsername === "string" && expectedUsername &&
      Array.isArray(ids) && ids.every(id => typeof id === "string")) {
    if (ids.length === 0) status = "no-matching-user-row";
    else if (ids.length > 1) status = "ambiguous-user-rows";
    else status = ids[0] === expectedUsername ? "identity-row-matched" : "identity-row-mismatched";
  }
  return {status, authenticationVerified:false, sessionMayBeIssued:false};
}
