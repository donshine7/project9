import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { reviewCandidate } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';
import { captureAcceptedRelationshipEntries } from '../lib/wiki';
import { auditRelationshipCoverage } from '../lib/relationship-audit';

const [mode, output, rehearsalPath, authorization, ...runIds] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !authorization?.trim() || !runIds.length) {
  throw new Error('Usage: dry-run|apply NEW_REPORT REHEARSAL_OR_DASH AUTHORIZATION RUN_ID...');
}
if (existsSync(output)) throw new Error('Report already exists');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type SourceCandidate = {
  id: string;
  run_id: string;
  kind: string;
  review_status: string;
  row_version: number;
  [key: string]: unknown;
};
const stateTables = ['mail_item','mail_matter_link','matter','matter_note','work_item','assignment','action_item','organization','person','matter_party','matter_group','matter_group_member'];
const protectedTables = ['mail_item','mail_matter_link','matter','matter_note','work_item','assignment','matter_group','matter_group_member'];
const tableState = (tables: string[]) => withDatabase(db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
const sourceCandidates = () => withDatabase(db => {
  const placeholders = runIds.map(() => '?').join(',');
  const candidates = db.prepare(`
    SELECT *
    FROM analysis_candidate
    WHERE run_id IN (${placeholders})
      AND kind IN ('link','action')
    ORDER BY created_at,id
  `).all(...runIds) as SourceCandidate[];
  return candidates.map(candidate => ({
    ...candidate,
    verifications: (db.prepare("SELECT payload_json FROM analysis_candidate WHERE kind='risk' AND entity_id=? ORDER BY created_at,id").all(candidate.id) as Array<{ payload_json: string }>)
      .map(verification => JSON.parse(verification.payload_json).fields.verdict),
  }));
});
const actionState = () => withDatabase(db => db.prepare('SELECT * FROM action_item ORDER BY rowid').all());

const backup = createBackup();
let clone: string | null = null;
const preStateHash = digest(tableState(stateTables));
const candidateHash = digest(sourceCandidates());
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `followup-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as { mode: string; preStateHash: string; candidateHash: string; protectedTablesUnchanged: boolean };
  if (rehearsal.mode !== 'dry-run' || !rehearsal.protectedTablesUnchanged || rehearsal.preStateHash !== preStateHash || rehearsal.candidateHash !== candidateHash) {
    throw new Error('Operational state or candidates changed since rehearsal');
  }
}

const protectedBefore = digest(tableState(protectedTables));
const actionsBefore = actionState();
const candidates = sourceCandidates();
const accepted: unknown[] = [];
const held: Array<{ id: string; reason: string }> = [];
for (const candidate of candidates) {
  if (candidate.review_status !== 'pending') {
    held.push({ id: candidate.id, reason: candidate.review_status });
    continue;
  }
  if (!candidate.verifications.length || candidate.verifications.some((verification: { value: string }) => verification.value !== 'confirmed')) {
    held.push({ id: candidate.id, reason: 'independent_confirmation_required' });
    continue;
  }
  accepted.push(reviewCandidate(candidate.id, { action: 'accept', expectedVersion: candidate.row_version, reason: authorization }));
}
const relationshipEntries = captureAcceptedRelationshipEntries();
const relationshipAudit = auditRelationshipCoverage();
if (protectedBefore !== digest(tableState(protectedTables))) throw new Error('Protected records changed');
const actionsAfter = actionState();
const beforeById = new Map(actionsBefore.map((action: any) => [action.id, action]));
for (const action of actionsAfter as any[]) {
  const before = beforeById.get(action.id);
  if (before && JSON.stringify(before) !== JSON.stringify(action)) throw new Error(`Existing Action changed: ${action.id}`);
}
if (actionsBefore.some((action: any) => !(actionsAfter as any[]).some(after => after.id === action.id))) throw new Error('Existing Action removed');
const insertedActionIds = new Set(accepted.filter((item: any) => item.appliedType === 'action').map((item: any) => item.appliedId));
const newActions = (actionsAfter as any[]).filter(action => !beforeById.has(action.id));
if (newActions.length !== insertedActionIds.size || newActions.some(action => !insertedActionIds.has(action.id))) throw new Error('Unexpected Action insertion');
const integrity = withDatabase(db => ({ check: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));
if (JSON.stringify(integrity.check) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw new Error('Integrity failed');
const counts = withDatabase(db => Object.fromEntries(['organization','person','matter_party','action_item','wiki_entry','entity_wiki_revision'].map(table => [table, db.prepare(`SELECT count(*) n FROM ${table}`).get()])));
const report = { mode, output, backup: backup.file, clone, authorization, runIds, accepted, held, relationshipEntries, relationshipMissing: relationshipAudit.findingCount, preStateHash, candidateHash, protectedTablesUnchanged: true, existingActionsUnchanged: true, newActionIds: [...insertedActionIds], counts, integrity };
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, accepted: accepted.length, held: held.length }));
