// Offline discovery only. Row values and response headers never leave this module.
// This is not an authentication verifier or a general MIME/resultset decoder.
const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = /^(bigint|int|char|varchar|nvarchar|decimal|numeric|float|double|date|datetime|timestamp|bit|binary)$/i;
const CREDENTIAL_COLUMN = /^(pw|pwd|password|passwd|.*token|.*secret|.*password|.*passwd|.*cookie|authorization|apikey)$/i;

export function credentialColumns(columns) {
  return columns.filter(name => CREDENTIAL_COLUMN.test(name.replaceAll("_", "")));
}

export function inspectResultsetSchema(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES) throw new Error("SCHEMA_REJECTED");
  // Read exactly the four metadata records, never parse or return data rows.
  const records = [];
  let offset = 0;
  for (let i = 0; i < 4; i++) {
    const end = text.indexOf("\r\n", offset);
    if (end < offset || end - offset > 32768) throw new Error("SCHEMA_REJECTED");
    records.push(text.slice(offset, end).split("\x01"));
    offset = end + 2;
  }
  const [columns, types, lengths] = records;
  if (!columns.length || columns.length > 512 ||
      columns.some(c => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(c)) ||
      new Set(columns.map(c => c.toLowerCase())).size !== columns.length ||
      records.some(r => r.length !== columns.length) ||
      types.some(t => !TYPES.test(t)) || lengths.some(n => !/^\d{1,10}$/.test(n)) ||
      records[3].some(f => /[\r\n"\x00]/.test(f))) throw new Error("SCHEMA_REJECTED");
  return {columns, types, credentialColumns: credentialColumns(columns), rowValuesParsed: false};
}

export function inspectMultipartSchemas({text, contentType, expectedPartCount, framing = "rfc2046"}) {
  try {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES ||
        !Number.isInteger(expectedPartCount) || expectedPartCount < 1 || expectedPartCount > 32 ||
        !["rfc2046", "observed-jbori"].includes(framing)) throw new Error();
    // Exact observed parameter grammar; no guessed boundary or automatic fallback.
    const match = /^multipart\/mixed\s*;\s*boundary=(?:"([-A-Za-z0-9]{1,70})"|([-A-Za-z0-9]{1,70}))(?:\s*;\s*charset=UTF-8)?\s*$/i.exec(contentType);
    if (!match) throw new Error();
    const boundary = match[1] ?? match[2];
    const delimiter = framing === "rfc2046" ? "--" + boundary : boundary;
    if (!text.startsWith(delimiter + "\r\n")) throw new Error();
    const segments = text.split("\r\n" + delimiter);
    if (segments.length !== expectedPartCount + 1 || !/^--(?:\r\n)?$/.test(segments.at(-1))) throw new Error();
    const schemas = segments.slice(0, -1).map((segment, index) => {
      const part = index === 0 ? segment.slice(delimiter.length + 2) : segment.slice(2);
      if (index > 0 && !segment.startsWith("\r\n")) throw new Error();
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd < 0 || headerEnd > 4096 ||
          !/^Content-Type:\s*text\/resultset\s*$/i.test(part.slice(0, headerEnd))) throw new Error();
      return {index, ...inspectResultsetSchema(part.slice(headerEnd + 4))};
    });
    return {framing, partCount: schemas.length, schemas, authenticationVerified: false, executable: false};
  } catch {
    throw new Error("MULTIPART_SCHEMA_REJECTED");
  }
}
