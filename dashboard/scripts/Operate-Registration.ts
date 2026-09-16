import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { applyVerifiedRegistration } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';

const [mode, candidateId, output, authorization, rehearsalFile] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !candidateId || !output || !authorization) throw Error('Usage: dry-run|apply CANDIDATE NEW_REPORT AUTHORIZATION [DRY_REPORT]');
if (existsSync(output)) throw Error('Report exists');
const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const backup = createBackup();
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `registration-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
}
const protectedTables = ['mail_item','work_item','assignment','action_item','matter_note','organization','person','matter_group','matter_group_member','matter_party','user_feedback','wiki_entry','entity_wiki_revision'];
const preserved = () => withDatabase(db => Object.fromEntries(protectedTables.map(t => [t, hash(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())])));
const state = () => withDatabase(db => ({ matters: db.prepare('SELECT * FROM matter ORDER BY rowid').all(), links: db.prepare('SELECT * FROM mail_matter_link ORDER BY rowid').all(), candidates: db.prepare('SELECT * FROM analysis_candidate ORDER BY rowid').all() }));
const before = state(), protectedHash = hash(preserved()), baselineHash = hash(before);
if (mode === 'apply') {
  const dry = JSON.parse(readFileSync(rehearsalFile || '', 'utf8'));
  if (dry.mode !== 'dry-run' || dry.candidateId !== candidateId || !dry.protectedDataUnchanged || dry.baselineHash !== baselineHash || dry.protectedHash !== protectedHash || dry.authorization !== authorization) throw Error('Matching fresh rehearsal required');
}
const result = applyVerifiedRegistration(candidateId, authorization);
const after = state();
if (hash(preserved()) !== protectedHash || before.matters.some(r => !after.matters.some(a => hash(a) === hash(r))) || before.links.some(r => !after.links.some(a => hash(a) === hash(r))) || after.matters.length !== before.matters.length + (result.duplicate ? 0 : 1) || after.links.length !== before.links.length + (result.duplicate ? 0 : 1)) throw Error('Unexpected mutation; inspect backup');
const replay = applyVerifiedRegistration(candidateId, authorization);
if (!replay.duplicate || hash(state()) !== hash(after)) throw Error('Replay is not idempotent');
const integrity = withDatabase(db => ({ check: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));
if (integrity.check?.integrity_check !== 'ok' || integrity.foreignKeys.length) throw Error('Integrity failed');
const report = { mode, candidateId, authorization, backup: backup.file, clone, baselineHash, protectedHash, protectedDataUnchanged: true, result, replay, integrity, beforeMatters: before.matters.length, afterMatters: after.matters.length };
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
