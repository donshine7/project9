import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { analysisStatus, prepareAnalysis, analysisPacket } from '../lib/analysis';
import { createBackup } from '../lib/work-db';

const output = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: Prepare-FactReview <new-private-output-directory>');
mkdirSync(output, { recursive: false });
const save = (name: string, data: unknown) => writeFileSync(path.join(output, name), JSON.stringify(data, null, 2), { flag: 'wx' });
const facts = analysisStatus().candidates.filter(c => c.kind === 'fact' && c.review_status === 'pending');
const unverified = facts.filter(c => !c.verifications.length);
const rework = facts.filter(c => c.verifications.some((v: { value: string }) => v.value !== 'confirmed'));
const backup = createBackup();
function prepare(operation: string, candidates: typeof facts, name: string) {
  const selectedMailIds = [...new Set(candidates.map(c => String(c.entity_id)))];
  const run = prepareAnalysis(operation, selectedMailIds);
  const packet = analysisPacket(run.runId);
  const original = JSON.stringify(packet);
  save(`${name}-full.json`, packet);
  // Deterministic focused view of the immutable packet, retaining every selected mail verbatim.
  // Facts do not need the unrelated entity and Action registry in the prompt.
  const targetIds = candidates.map(c => c.id);
  save(`${name}.json`, { schemaVersion: packet.schemaVersion, runId: packet.runId, operation: packet.operation, route: packet.route, sourcePacketHash: createHash('sha256').update(original).digest('hex'), mails: packet.mails, targetCandidates: packet.context.candidates.filter((c: { id: string }) => targetIds.includes(c.id)) });
  return { ...run, targetIds, packet: path.join(output, `${name}.json`) };
}
const verification = [];
for (let i = 0; i < unverified.length; i += 24) verification.push(prepare('high_risk_verification', unverified.slice(i, i + 24), `verify-${verification.length + 1}`));
const rewrite = rework.length ? prepare('mail_fact_extraction', rework, 'rewrite') : null;
const manifest = { backup: backup.file, counts: { unverified: unverified.length, rework: rework.length }, verification, rewrite };
save('manifest.json', manifest);
console.log(JSON.stringify(manifest, null, 2));
