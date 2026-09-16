import { readFileSync, writeFileSync } from 'node:fs';
const [packetPath, compactPath, output] = process.argv.slice(2);
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const packet = read(packetPath);
const mails = packet.mails as Array<Record<string, string>>;
const compact = read(compactPath) as Array<[string, string, number, string, Array<[string, string]>]>;
const seen = new Set<string>();
const candidates = compact.map(([prefix, value, confidence, rationale, quotes]) => {
  const matches = mails.filter(m => m.id.startsWith(prefix));
  if (matches.length !== 1 || seen.has(matches[0].id)) throw new Error(`Ambiguous/duplicate mail ${prefix}`);
  const mail = matches[0]; seen.add(mail.id);
  const evidence = quotes.map(([field, quote]) => {
    if (!mail[field]?.includes(quote)) throw new Error(`Nonliteral evidence ${prefix}: ${quote}`);
    return { mailId: mail.id, field, quote };
  });
  return { key: `fact-${prefix}`, kind: 'fact', entityType: 'mail', entityId: mail.id, fields: { summary: { value, confidence, rationale, evidence } } };
});
if (seen.size !== mails.length) throw new Error('Incomplete coverage');
writeFileSync(output, JSON.stringify({ schemaVersion: 1, runId: packet.runId, coverage: candidates.map(c => ({ mailId: c.entityId, outcome: 'candidate', reason: c.fields.summary.rationale })), candidates }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, count: candidates.length }));
