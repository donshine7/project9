import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { analysisStatus, reviewCandidate } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';

// Main-task bridge. Only independently confirmed, missing, single-field mail links.
const [mode, runId, output, reason] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !runId || !output || !reason?.trim()) throw Error('Usage: dry-run|apply RUN_ID NEW_REPORT AUTHORIZATION_REASON');
if (existsSync(output)) throw Error('Report already exists; refusing repeat mutation');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const backup = createBackup();
let clone: string | null = null;
type Rehearsal = {mode: string; runId: string; protectedDataUnchanged: boolean; baselineHash: string; oldLinksHash: string; candidateHash: string};
let rehearsal: Rehearsal | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `links-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const parsedRehearsal = JSON.parse(readFileSync(process.argv[6] || '', 'utf8')) as Rehearsal;
  if (parsedRehearsal.mode !== 'dry-run' || parsedRehearsal.runId !== runId || !parsedRehearsal.protectedDataUnchanged) throw Error('Matching successful rehearsal required');
  rehearsal = parsedRehearsal;
}
const tables = ['mail_item','matter','work_item','assignment','action_item','matter_note','organization','person','matter_group','matter_group_member','matter_party','entity_wiki_revision'];
const protectedState = () => withDatabase(db => Object.fromEntries(tables.map(t => [t, hash(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())])));
const links = () => withDatabase(db => db.prepare('SELECT * FROM mail_matter_link ORDER BY mail_id,matter_id').all());
const before = hash(protectedState()), oldLinks = links();
const candidates = analysisStatus().candidates.filter(c => c.run_id === runId);
if (!candidates.length || candidates.some(c => c.kind !== 'link' || Object.keys(c.payload.fields).join() !== 'matterRef')) throw Error('Run is not a pure mail-link review');
const candidateHash = hash(candidates);
if (rehearsal && (rehearsal.baselineHash !== before || rehearsal.oldLinksHash !== hash(oldLinks) || rehearsal.candidateHash !== candidateHash)) throw Error('Data changed since rehearsal');
const accepted: Array<{ candidateId: string; mailId: string; matterRef: string; matterId: string; preexisting: boolean; result: unknown }> = [], held = [];
for (const c of candidates) {
  if (c.review_status !== 'pending' || !c.verifications.length || c.verifications.some((v: {value: string}) => v.value !== 'confirmed')) {
    held.push({ id: c.id, reason: 'not_pending_or_not_independently_confirmed' }); continue;
  }
  const matter = withDatabase(db => db.prepare('SELECT id FROM matter WHERE our_ref=? AND archived_at IS NULL').get(c.payload.fields.matterRef.value) as { id: string } | undefined);
  if (!matter) throw Error('Link target stale');
  const preexisting = oldLinks.some(l => l.mail_id === c.entity_id && l.matter_id === matter.id);
  accepted.push({ candidateId: c.id, mailId: c.entity_id, matterRef: c.payload.fields.matterRef.value, matterId: matter.id, preexisting, result: reviewCandidate(c.id, { action: 'accept', expectedVersion: c.row_version, reason }) });
}
const afterLinks = links();
const acceptedPairs = new Set(accepted.map(item => `${item.mailId}\u0000${item.matterId}`));
const unchangedOldLinks = oldLinks.filter(link => !acceptedPairs.has(`${link.mail_id}\u0000${link.matter_id}`));
const insertedCount = accepted.filter(item => !item.preexisting).length;
const acceptedLinksValid = accepted.every(item => afterLinks.some(link => link.mail_id === item.mailId && link.matter_id === item.matterId && link.match_source === 'user_input' && link.confidence === 1));
if (before !== hash(protectedState()) || unchangedOldLinks.some(l => !afterLinks.some(a => hash(a) === hash(l))) || afterLinks.length !== oldLinks.length + insertedCount || !acceptedLinksValid) throw Error('Unexpected business-data change; inspect backup');
const integrity = withDatabase(db => ({ check: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));
if (JSON.stringify(integrity.check) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw Error('Database integrity failed');
const report = { mode, runId, backup: backup.file, clone, accepted, held, beforeLinks: oldLinks.length, afterLinks: afterLinks.length, baselineHash: before, oldLinksHash: hash(oldLinks), candidateHash, protectedDataUnchanged: true, integrity };
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, accepted: accepted.length, output }));
