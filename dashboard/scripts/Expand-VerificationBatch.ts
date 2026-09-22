import { readFileSync, writeFileSync } from 'node:fs';

type Quote = [string, string, string] | [string, string, number, number];
type Verdict = [string, string, number, string, Quote[]];
type Coverage = [string, string, string];

const [packetPath, compactPath, output] = process.argv.slice(2);
if (!packetPath || !compactPath || !output) throw new Error('Usage: PACKET COMPACT NEW_OUTPUT');
const packet = JSON.parse(readFileSync(packetPath, 'utf8'));
const compact = JSON.parse(readFileSync(compactPath, 'utf8')) as { verdicts: Verdict[]; coverage: Coverage[] };
const targets = packet.targetCandidates as Array<{ id: string }>;
const seen = new Set<string>();
const resolveMail = (prefix: string) => {
  const matches = packet.mails.filter((mail: { id: string }) => mail.id.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`Ambiguous mail prefix: ${prefix}`);
  return matches[0];
};

if (compact.verdicts.length !== targets.length) throw new Error('Incomplete verifier target coverage');
const candidates = compact.verdicts.map(([prefix, verdict, confidence, rationale, quotes]) => {
  const matches = targets.filter(candidate => candidate.id.startsWith(prefix));
  if (matches.length !== 1 || seen.has(matches[0].id)) throw new Error(`Ambiguous or duplicate candidate: ${prefix}`);
  seen.add(matches[0].id);
  const evidence = quotes.map(parts => {
    const mail = resolveMail(parts[0]);
    const field = parts[1];
    if (typeof mail[field] !== 'string') throw new Error(`Invalid evidence field: ${field}`);
    const quote = parts.length === 4 ? mail[field].slice(parts[2], parts[3]) : parts[2];
    if (!quote || !mail[field].includes(quote)) throw new Error(`Nonliteral evidence: ${parts[0]}`);
    return { mailId: mail.id, field, quote };
  });
  return {
    key: `verify-${prefix}`,
    kind: 'risk',
    entityType: 'candidate',
    entityId: matches[0].id,
    fields: { verdict: { value: verdict, confidence, rationale, evidence } },
  };
});

const coverage = compact.coverage.map(([prefix, outcome, reason]) => ({ mailId: resolveMail(prefix).id, outcome, reason }));
if (coverage.length !== packet.mails.length || new Set(coverage.map(item => item.mailId)).size !== packet.mails.length) {
  throw new Error('Incomplete or duplicate mail coverage');
}
const cited = new Set(candidates.flatMap(candidate => candidate.fields.verdict.evidence.map(evidence => evidence.mailId)));
for (const item of coverage) if (item.outcome === 'candidate' && !cited.has(item.mailId)) throw new Error(`Candidate coverage without evidence: ${item.mailId}`);

writeFileSync(output, JSON.stringify({ schemaVersion: 1, runId: packet.runId, coverage, candidates }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, candidates: candidates.length, coverage: coverage.length }));
