const MASK = /!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

// Observed Jbori resultset: four metadata records, SOH field separator,
// CRLF records, double-quoted character values. No generic CSV guessing.
export function parseResultset(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("invalid resultset size");
  if (MASK.test(text)) throw new Error("masked resultset cannot establish original values");
  const records = [];
  let fields = [], value = "", quoted = false, afterQuote = false, cellQuoted = false;
  const cell = () => { fields.push({ value, quoted: cellQuoted }); value = ""; cellQuoted = false; afterQuote = false; };
  const record = () => { cell(); records.push(fields); fields = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (c === '"') { quoted = false; afterQuote = true; }
      else value += c;
      continue;
    }
    if (c === '"' && value === "" && !afterQuote) { quoted = true; cellQuoted = true; continue; }
    if (c === "\x01") { cell(); continue; }
    if (c === "\r" && text[i + 1] === "\n") { record(); i++; continue; }
    if (c === "\n") { record(); continue; }
    if (afterQuote || c === '"' || c === "\r") throw new Error("invalid resultset quoting");
    value += c;
  }
  if (quoted) throw new Error("unterminated resultset quote");
  if (value || fields.length || cellQuoted) record();
  if (records.length < 4) throw new Error("incomplete resultset metadata");
  const columns = records[0].map(c => c.value);
  if (!columns.length || columns.some(c => !/^[\p{L}_][\p{L}\p{N}_]{0,127}$/u.test(c)) || new Set(columns.map(c => c.toLowerCase())).size !== columns.length) {
    throw new Error("invalid resultset columns");
  }
  if (records.some(r => r.length !== columns.length)) throw new Error("resultset field count mismatch");
  const types = records[1].map(c => c.value);
  if (types.some(t => !/^(bigint|int|char|varchar|nvarchar|decimal|numeric|float|double|date|datetime|timestamp|bit|binary)$/i.test(t))) throw new Error("unsupported resultset type");
  if (records[2].some(c => !/^\d+$/.test(c.value))) throw new Error("invalid resultset lengths");
  const rows = records.slice(4).map(r => Object.fromEntries(r.map((c, i) => [columns[i], !c.quoted && c.value === "null" ? null : c.value])));
  return { columns, types, rows };
}
