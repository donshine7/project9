import { readFileSync, writeFileSync } from 'node:fs';
// Mechanical adapter; no inference, DB access, or evidence rewriting.
const [packetPath, compactPath, output] = process.argv.slice(2);
const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
const compact = JSON.parse(readFileSync(compactPath, 'utf8'));
if (compact.runId !== packet.runId) throw Error('Run mismatch');
type Link = [string, string, number, string, [string, string, string][]];
const candidates = (compact.links as Link[]).map(([mailId, ref, confidence, rationale, quotes], i) => {
  if (!packet.findings.some((f: {mailId: string; matterRef: string}) => f.mailId === mailId && f.matterRef === ref)) throw Error('Out-of-scope link');
  const evidence = quotes.map(([id, field, quote]) => {
    const mail = packet.mails.find((m: {id: string}) => m.id === id);
    if (id !== mailId || !quote || typeof mail?.[field] !== 'string' || !mail[field].includes(quote)) throw Error(`Invalid quote ${id}/${ref}`);
    return {mailId: id, field, quote};
  });
  return { key: `missing-link-${i + 1}`, kind: 'link', entityType: 'mail', entityId: mailId, fields: { matterRef: { value: ref, confidence, rationale, evidence } } };
});
writeFileSync(output, JSON.stringify({ schemaVersion: 1, runId: packet.runId, coverage: compact.coverage, candidates }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({runId: packet.runId, candidates: candidates.length, output}));
