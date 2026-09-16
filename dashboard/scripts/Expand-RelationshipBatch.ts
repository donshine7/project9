import { readFileSync, writeFileSync } from 'node:fs';
const [packetPath, compactPath, output] = process.argv.slice(2);
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const packet = read(packetPath), compact = read(compactPath);
type Mail = Record<string, string>;
const resolve = (prefix: string): Mail => {
  const matches = packet.mails.filter((m: Mail) => m.id.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`Ambiguous mail ${prefix}`);
  return matches[0];
};
const fieldNames = ['matterRef', 'partyType', 'businessType', 'name', 'email', 'role'];
type Group = { mail: string; refs: string[]; key: string; quotes: [string,string][]; fields: [string|null,number,string,number][] };
const candidates = (compact.groups as Group[]).flatMap(g => g.refs.map(ref => {
  const mail = resolve(g.mail);
  if (g.fields.length !== 6) throw new Error('Six fields required');
  const replace = (s: string) => s.replaceAll('{ref}', ref);
  const fields = Object.fromEntries(g.fields.map(([value, confidence, rationale, index], i) => {
    const [field, q] = g.quotes[index], quote = replace(q);
    if (!mail[field]?.includes(quote)) throw new Error(`Nonliteral quote ${mail.id} ${quote}`);
    return [fieldNames[i], { value: value === null ? null : replace(value), confidence, rationale, evidence: [{ mailId: mail.id, field, quote }] }];
  }));
  return { key: `party-${ref}-${g.key}`, kind: 'link', entityType: 'mail', entityId: mail.id, fields };
}));
const candidateMails = new Set(candidates.map(c => c.entityId));
const needsReview = new Set(compact.needsReview.map((p: string) => resolve(p).id));
if ([...needsReview].some(id => candidateMails.has(String(id)))) throw new Error('Overlapping coverage');
const coverage = packet.mails.map((m: Mail) => ({ mailId: m.id, outcome: candidateMails.has(m.id) ? 'candidate' : needsReview.has(m.id) ? 'needs_review' : 'no_change', reason: candidateMails.has(m.id) ? '명시된 기존 사건-당사자 관계 후보' : needsReview.has(m.id) ? compact.needsReviewReason : compact.noChangeReason }));
writeFileSync(output, JSON.stringify({ schemaVersion: 1, runId: packet.runId, coverage, candidates }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, candidates: candidates.length, coverage: coverage.length }));
