import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { reviewCandidate } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';

const [mode, output, rehearsalPath, authorization, verifierRunId, ...candidateIds] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !authorization?.trim() || !verifierRunId || !candidateIds.length) {
  throw new Error('Usage: dry-run|apply OUTPUT REHEARSAL_OR_DASH AUTHORIZATION VERIFIER_RUN_ID CANDIDATE_ID...');
}
if (existsSync(output) || new Set(candidateIds).size !== candidateIds.length) throw new Error('Output exists or candidates are duplicated');

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protectedTables = [
  'mail_item', 'mail_matter_link', 'matter', 'matter_note', 'work_item', 'assignment', 'action_item',
  'organization', 'person', 'matter_party', 'matter_group', 'matter_group_member', 'wiki_entry', 'entity_wiki_revision',
];
const tableState = () => withDatabase(db => Object.fromEntries(
  protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
));
const candidateState = () => withDatabase(db => candidateIds.map(id => ({
  candidate: db.prepare('SELECT * FROM analysis_candidate WHERE id=?').get(id),
  verifications: db.prepare("SELECT * FROM analysis_candidate WHERE kind='risk' AND entity_id=? ORDER BY created_at,id").all(id),
})));

const backup = createBackup();
let clone: string | null = null;
const preStateHash = hash(tableState());
const sourceCandidateHash = hash(candidateState());
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `candidate-reject-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as {
    mode: string;
    preStateHash: string;
    sourceCandidateHash: string;
    protectedTablesUnchanged: boolean;
  };
  if (rehearsal.mode !== 'dry-run' || !rehearsal.protectedTablesUnchanged
    || rehearsal.preStateHash !== preStateHash || rehearsal.sourceCandidateHash !== sourceCandidateHash) {
    throw new Error('Operational state or candidates changed since rehearsal');
  }
}

const protectedBefore = hash(tableState());
const rejected = candidateIds.map(id => {
  const source = withDatabase(db => {
    const candidate = db.prepare('SELECT * FROM analysis_candidate WHERE id=?').get(id) as { kind: string; payload_json: string; review_status: string; row_version: number } | undefined;
    const verifier = db.prepare("SELECT * FROM analysis_candidate WHERE run_id=? AND kind='risk' AND entity_id=?").get(verifierRunId, id) as { payload_json: string } | undefined;
    if (!candidate || candidate.review_status !== 'pending' || candidate.kind === 'risk' || candidate.kind === 'wiki') throw new Error(`Candidate is not rejectable and pending: ${id}`);
    if (!verifier || JSON.parse(verifier.payload_json).fields?.verdict?.value !== 'rejected') throw new Error(`Rejected verifier missing: ${id}`);
    return candidate;
  });
  return reviewCandidate(id, { action: 'reject', expectedVersion: source.row_version, reason: authorization });
});

if (protectedBefore !== hash(tableState())) throw new Error('Protected business records changed');
const integrity = withDatabase(db => ({ check: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));
if (integrity.check?.integrity_check !== 'ok' || integrity.foreignKeys.length) throw new Error('Integrity failed');
const report = {
  mode, output, backup: backup.file, clone, authorization, verifierRunId, candidateIds, rejected,
  preStateHash, sourceCandidateHash, protectedTablesUnchanged: true, integrity,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, rejected: rejected.length }));
