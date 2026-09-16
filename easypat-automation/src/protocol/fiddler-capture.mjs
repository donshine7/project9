import { summarizeCapturedEnvelope } from "./read-only-guard.mjs";
import { fingerprintEnvelope } from "./template-fingerprint.mjs";

const ENDPOINT = "https://mssql2.easypnp.co.kr:8443/servlet/Jbori";
const MAX_BODY_BYTES = 1024 * 1024;

// Only an actual session object is data. Tool notices/errors are not SQL.
export function unwrapFiddlerSession(result) {
  if (!result || result.isError) throw new Error("Fiddler session retrieval failed");
  if (result.structuredContent?.requestBody) return result.structuredContent;
  if (result.requestBody) return result;
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue;
    try {
      const parsed = JSON.parse(block.text);
      if (parsed?.requestBody) return parsed;
    } catch { /* A tool notice is not a session. */ }
  }
  throw new Error("Fiddler response contains no structured session");
}

// Returns raw statements in memory only; callers must never log this envelope.
export function extractCapturedEnvelope(result) {
  const session = unwrapFiddlerSession(result);
  if (session.url !== ENDPOINT || session.method !== "POST") {
    throw new Error("capture is outside the authorized endpoint");
  }
  if (String(session.statusCode) !== "200") throw new Error("capture response was not successful");
  const body = session.requestBody;
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(body?.mimeType ?? "")) {
    throw new Error("unsupported capture request encoding");
  }
  if (typeof body.content !== "string" || body.content.length > MAX_BODY_BYTES * 2) {
    throw new Error("capture request body is missing or too large");
  }
  if (body.isBase64 && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.content)) {
    throw new Error("invalid base64 capture request");
  }
  const bytes = Buffer.from(body.content, body.isBase64 ? "base64" : "utf8");
  if (bytes.length > MAX_BODY_BYTES) throw new Error("capture request body is too large");
  let form;
  try {
    form = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw new Error("capture request is not valid UTF-8"); }
  const fields = new Map();
  for (const entry of form.split("&")) {
    const pos = entry.indexOf("=");
    if (pos < 1) throw new Error("invalid form field");
    let key, value;
    try {
      key = decodeURIComponent(entry.slice(0, pos).replace(/\+/g, " "));
      value = decodeURIComponent(entry.slice(pos + 1).replace(/\+/g, " "));
    } catch { throw new Error("invalid form percent encoding"); }
    if (!/^(connection|count|command|sql|sql\d+)$/.test(key)) throw new Error("unexpected capture field");
    if (fields.has(key)) throw new Error("duplicate capture field");
    fields.set(key, value);
  }
  if (fields.get("connection") !== "EASYPAT_S_SSPAT") throw new Error("unexpected database connection");
  if (!/^[1-9]\d?$/.test(fields.get("count") ?? "")) throw new Error("invalid statement count");
  const count = Number(fields.get("count"));
  const keys = count === 1 && fields.has("sql") ? ["sql"] : Array.from({ length: count }, (_, i) => `sql${i}`);
  if (fields.size !== 3 + count || keys.some(key => !fields.has(key))) {
    throw new Error("capture statement count or indexes do not match");
  }
  const command = fields.get("command");
  if (!["SELECT", "OTHERS", "UPDATE", "INSERT", "DELETE", "EXEC"].includes(command)) {
    throw new Error("unsupported capture command");
  }
  const statements = keys.map(key => fields.get(key));
  if (statements.some(s => !s.trim() || /!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i.test(s))) {
    throw new Error("capture statements are missing or sanitized");
  }
  return { command, statements };
}

export function inspectFiddlerCapture(result, templateId = "capture-inspection") {
  const session = unwrapFiddlerSession(result);
  const input = extractCapturedEnvelope(session);
  const envelope = { templateId, ...input };
  const summary = summarizeCapturedEnvelope(envelope);
  const read = summary.classification === "read-only-candidate";
  return {
    sessionId: session.id,
    ...summary,
    fingerprint: read ? fingerprintEnvelope(envelope) : null,
    responseMimeType: session.responseBody?.mimeType ?? null,
    executable: false,
    scope: "exact-captured-request-only",
  };
}
