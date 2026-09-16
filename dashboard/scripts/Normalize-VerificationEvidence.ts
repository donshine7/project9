import { readFileSync, writeFileSync } from 'node:fs';

const [packetFile, resultFile, outputFile, reportFile] = process.argv.slice(2);
if (!packetFile || !resultFile || !outputFile || !reportFile) throw Error('Usage: VERIFICATION_PACKET RAW_RESULT NEW_RESULT NEW_REPORT');
const packet = JSON.parse(readFileSync(packetFile, 'utf8'));
const result = JSON.parse(readFileSync(resultFile, 'utf8'));
if (packet.runId !== result.runId) throw Error('Run mismatch');
const mails = new Map(packet.mails.map((m: any) => [m.id, m]));
const targets = new Map(packet.targetCandidates.map((c: any) => [c.id, c]));
const corrections: any[] = [];
for (const candidate of result.candidates) {
  const target: any = targets.get(candidate.entityId);
  if (!target) throw Error(`Unknown target ${candidate.entityId}`);
  const sourceMailId = target.entity_id;
  const source: any = mails.get(sourceMailId);
  if (!source) throw Error(`Missing source mail ${sourceMailId}`);
  for (const field of Object.values(candidate.fields) as any[]) for (const evidence of field.evidence) {
    const cited: any = mails.get(evidence.mailId);
    if (cited && typeof cited[evidence.field] === 'string' && cited[evidence.field].includes(evidence.quote)) continue;
    if (typeof source[evidence.field] !== 'string' || !source[evidence.field].includes(evidence.quote)) throw Error(`Cannot repair evidence for ${candidate.key}`);
    corrections.push({ candidateKey: candidate.key, from: evidence.mailId, to: sourceMailId, field: evidence.field, quote: evidence.quote });
    evidence.mailId = sourceMailId;
  }
}
if (!corrections.length) throw Error('No correction required');
writeFileSync(outputFile, JSON.stringify(result, null, 2), { flag: 'wx' });
writeFileSync(reportFile, JSON.stringify({ runId: result.runId, corrections }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ runId: result.runId, corrections: corrections.length, outputFile, reportFile }));
