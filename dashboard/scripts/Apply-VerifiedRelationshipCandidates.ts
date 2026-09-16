import { analysisStatus, reviewCandidate } from '../lib/analysis';
import { createBackup } from '../lib/work-db';

const runIds = new Set(process.argv.slice(2));
if (!runIds.size) throw new Error('Usage: Apply-VerifiedRelationshipCandidates <matter-link-run-id>...');
const backup = createBackup();
const candidates = analysisStatus().candidates.filter((candidate: any) => runIds.has(candidate.run_id) && candidate.kind === 'link' && candidate.review_status === 'pending');
let accepted = 0, held = 0;
for (const candidate of candidates) {
  if (!candidate.verifications.length || candidate.verifications.some((verification: any) => verification.value !== 'confirmed')) {
    held += 1;
    continue;
  }
  reviewCandidate(candidate.id, { action: 'accept', expectedVersion: candidate.row_version });
  accepted += 1;
}
process.stdout.write(JSON.stringify({ backup: backup.file, candidateCount: candidates.length, accepted, held }, null, 2));
