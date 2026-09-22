import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createBackup, withDatabase } from '../lib/work-db';
import { captureVerifiedMail } from '../lib/wiki';

const [mode, output, rehearsalPath, candidateId, matterRef, authorization] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !candidateId || !matterRef || !authorization?.trim()) {
  throw new Error('Usage: dry-run|apply NEW_REPORT REHEARSAL_OR_DASH CANDIDATE_ID MATTER_REF AUTHORIZATION');
}
if (existsSync(output)) throw new Error('Report already exists');

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protectedTables = [
  'mail_item', 'mail_matter_link', 'matter', 'matter_note', 'work_item', 'assignment',
  'action_item', 'organization', 'person', 'matter_party', 'matter_group',
  'matter_group_member', 'user_feedback', 'knowledge_entry', 'entity_wiki_revision',
];
const tableState = (tables: string[]) => withDatabase((db) => Object.fromEntries(
  tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
));
const sourceState = () => withDatabase((db) => {
  const candidate = db.prepare("SELECT * FROM analysis_candidate WHERE id=? AND kind='fact'").get(candidateId);
  if (!candidate) throw new Error('Fact candidate not found');
  const matter = db.prepare('SELECT * FROM matter WHERE our_ref=? AND archived_at IS NULL').get(matterRef) as { id: string } | undefined;
  if (!matter) throw new Error('Matter not found');
  const verifications = db.prepare("SELECT * FROM analysis_candidate WHERE kind='risk' AND entity_id=? ORDER BY created_at,id").all(candidateId);
  const links = db.prepare('SELECT * FROM mail_matter_link WHERE matter_id=? ORDER BY mail_id').all(matter.id);
  return { candidate, matter, verifications, links };
});

const beforeStateHash = digest(tableState(protectedTables));
const beforeSourceHash = digest(sourceState());
const backup = createBackup();
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `target-fact-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as {
    mode: string;
    beforeStateHash: string;
    beforeSourceHash: string;
    protectedTablesUnchanged: boolean;
  };
  if (rehearsal.mode !== 'dry-run' || !rehearsal.protectedTablesUnchanged
      || rehearsal.beforeStateHash !== beforeStateHash || rehearsal.beforeSourceHash !== beforeSourceHash) {
    throw new Error('Operational state or verified fact changed since rehearsal');
  }
}

const source = sourceState();
const verdicts = source.verifications.map((row: any) => JSON.parse(row.payload_json).fields.verdict.value);
if (!verdicts.length || verdicts.some((value) => value !== 'confirmed')) throw new Error('All independent verdicts must be confirmed');
const result = captureVerifiedMail(candidateId, (source.matter as any).id);
if (beforeStateHash !== digest(tableState(protectedTables))) throw new Error('Protected records changed');
const integrity = withDatabase((db) => ({
  check: db.prepare('PRAGMA integrity_check').get(),
  foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
}));
if (JSON.stringify(integrity.check) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw new Error('Integrity failed');
const after = withDatabase((db) => ({
  entry: db.prepare("SELECT * FROM wiki_entry WHERE entity_type='matter' AND entity_id=? AND source_candidate_id=?").get((source.matter as any).id, candidateId),
  wikiEntryCount: db.prepare('SELECT count(*) n FROM wiki_entry').get(),
  revisionCount: db.prepare('SELECT count(*) n FROM entity_wiki_revision').get(),
  actionCount: db.prepare('SELECT count(*) n FROM action_item').get(),
}));
const report = {
  mode, output, backup: backup.file, clone, candidateId, matterRef, authorization,
  beforeStateHash, beforeSourceHash, result, after, protectedTablesUnchanged: true, integrity,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, after: { ...after, entry: Boolean(after.entry) } }));
