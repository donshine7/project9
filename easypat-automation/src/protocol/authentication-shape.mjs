// Local offline inspection only. Never returns SQL literal values or cookie values.
// Trusted local callers only: spans contain raw secrets and must never be logged.
export function scanAuthenticationSql(sql) {
  if (typeof sql !== "string" || !sql.trim() || sql.length > 65536 || /sanitized|\[REDACTED\]/i.test(sql)) throw new Error("AUTH_SHAPE_REJECTED");
  const tokens = [];
  const literalSpans = [];
  let commentCount = 0;
  let literalCount = 0;
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    let m;
    if ((m = /^\s+/.exec(rest))) { i += m[0].length; continue; }
    if (rest.startsWith("--")) { commentCount++; const end = rest.search(/[\r\n]/); i += end < 0 ? rest.length : end; continue; }
    if (rest.startsWith("/*")) {
      commentCount++;
      const end = rest.indexOf("*/", 2);
      if (end < 0 || rest.slice(2, end).includes("/*")) throw new Error("AUTH_SHAPE_REJECTED");
      i += end + 2; continue;
    }
    // Treat double-quoted text conservatively as a literal, not an identifier.
    if ((m = /^(?:N)?'(?:[^']|'')*'|^"(?:[^"]|"")*"/i.exec(rest)) ||
        (m = /^0x[0-9a-f]+\b/i.exec(rest)) ||
        (m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?\b/i.exec(rest))) {
      literalSpans.push({start:i,end:i+m[0].length,raw:m[0]});
      tokens.push("<value>"); literalCount++; i += m[0].length; continue;
    }
    if ((m = /^\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(rest))) { tokens.push(m[1]); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) { tokens.push(m[0]); i += m[0].length; continue; }
    if (/^[.,=()<>+*/;%!-]/.test(rest)) { tokens.push(rest[0]); i++; continue; }
    throw new Error("AUTH_SHAPE_REJECTED");
  }
  if (tokens[0]?.toUpperCase() !== "SELECT") throw new Error("AUTH_SHAPE_REJECTED");
  return {shape:tokens.join(" "), literalCount, literalSpans, commentCount};
}

export function inspectAuthenticationSql(sql) {
  const {shape, literalCount} = scanAuthenticationSql(sql);
  return {status:"shape-inspected", shape, literalCount, valuesIncluded:false, executable:false, authenticationVerified:false};
}

export function inspectCookieShape(header) {
  if (typeof header !== "string" || header.length > 8192) throw new Error("COOKIE_SHAPE_REJECTED");
  const normalized = header.trim();
  if (/[\r\n]|sanitized|\[REDACTED\]/i.test(normalized)) throw new Error("COOKIE_SHAPE_REJECTED");
  const parts = normalized.replace(/^Set-Cookie(?::|\t)\s*/i, "").split(";");
  const first = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+)=([^;]*)$/.exec(parts.shift());
  if (!first) throw new Error("COOKIE_SHAPE_REJECTED");
  const attributes = [];
  const seen = new Set();
  for (const part of parts) {
    const [key, ...rest] = part.trim().split("=");
    if (!/^(path|domain|secure|httponly|samesite|max-age|expires)$/i.test(key) || seen.has(key.toLowerCase())) throw new Error("COOKIE_SHAPE_REJECTED");
    seen.add(key.toLowerCase());
    const value = rest.join("=");
    if (/[\x00-\x1f\x7f]/.test(value) ||
        (/^(secure|httponly)$/i.test(key) && rest.length) ||
        (/^path$/i.test(key) && !/^\/[A-Za-z0-9_./-]*$/.test(value)) ||
        (/^domain$/i.test(key) && !/^\.?[A-Za-z0-9.-]+$/.test(value)) ||
        (/^samesite$/i.test(key) && !/^(lax|strict|none)$/i.test(value)) ||
        (/^max-age$/i.test(key) && !/^-?\d+$/.test(value)) ||
        (/^expires$/i.test(key) && (!Number.isFinite(Date.parse(value)) || !/^[A-Za-z0-9,: -]+$/.test(value)))) throw new Error("COOKIE_SHAPE_REJECTED");
    attributes.push({name:key, value});
  }
  return {status:"shape-inspected",name:first[1],attributes,valuesIncluded:false,executable:false,authenticationVerified:false};
}
