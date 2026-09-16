import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { analysisStatus, applyVerifiedRegistration } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';

const [mode, output, authorization, rehearsalFile, ...candidateIds] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !authorization || !candidateIds.length) throw Error('Usage: dry-run|apply NEW_REPORT AUTHORIZATION DRY_REPORT_OR_DASH CANDIDATE_IDS...');
if (existsSync(output) || new Set(candidateIds).size !== candidateIds.length) throw Error('Output exists or duplicate candidates');
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const backup = createBackup();
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `active-registration-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
}
const protectedTables = ['mail_item','work_item','assignment','action_item','matter_note','organization','person','matter_group','matter_group_member','matter_party','user_feedback','wiki_entry','entity_wiki_revision'];
const protectedState = () => withDatabase(db => Object.fromEntries(protectedTables.map(t => [t, hash(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())])));
const oldMatters = withDatabase(db => db.prepare('SELECT * FROM matter ORDER BY rowid').all());
const oldLinks = withDatabase(db => db.prepare('SELECT * FROM mail_matter_link ORDER BY rowid').all());
const baselineHash = hash({ oldMatters, oldLinks });
const protectedHash = hash(protectedState());
const selected = analysisStatus().candidates.filter(c => candidateIds.includes(c.id));
if (selected.length !== candidateIds.length || selected.some(c => c.kind !== 'link' || !c.payload.fields.registrationBasis || c.review_status !== 'pending')) throw Error('Candidates are not pending new-matter proposals');
const candidateHash = hash(selected.map(c => ({ id: c.id, rowVersion: c.row_version, payload: c.payload, verifications: c.verifications })));
if (mode === 'apply') {
  const rehearsal = JSON.parse(readFileSync(rehearsalFile || '', 'utf8'));
  if (rehearsal.mode !== 'dry-run' || rehearsal.authorization !== authorization || rehearsal.baselineHash !== baselineHash || rehearsal.protectedHash !== protectedHash || rehearsal.candidateHash !== candidateHash || JSON.stringify(rehearsal.candidateIds) !== JSON.stringify(candidateIds) || !rehearsal.protectedDataUnchanged) throw Error('Matching fresh rehearsal required');
}
const applied = candidateIds.map(id => applyVerifiedRegistration(id, authorization));
const matters = withDatabase(db => db.prepare('SELECT * FROM matter ORDER BY rowid').all());
const links = withDatabase(db => db.prepare('SELECT * FROM mail_matter_link ORDER BY rowid').all());
if (hash(protectedState()) !== protectedHash || oldMatters.some(r => !matters.some(a => hash(a) === hash(r))) || oldLinks.some(r => !links.some(a => hash(a) === hash(r))) || matters.length !== oldMatters.length + candidateIds.length || links.length !== oldLinks.length + candidateIds.length) throw Error('Unexpected business-data mutation; inspect backup');
const replay = candidateIds.map(id => applyVerifiedRegistration(id, authorization));
if (replay.some(r => !r.duplicate)) throw Error('Replay is not idempotent');
const integrity = withDatabase(db => ({ check: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));
if (integrity.check?.integrity_check !== 'ok' || integrity.foreignKeys.length) throw Error('Integrity failed');
const report = { mode, authorization, candidateIds, backup: backup.file, clone, baselineHash, protectedHash, candidateHash, protectedDataUnchanged: true, beforeMatters: oldMatters.length, afterMatters: matters.length, beforeLinks: oldLinks.length, afterLinks: links.length, applied, replay, integrity };
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, applied: applied.length, replay: replay.length }));
