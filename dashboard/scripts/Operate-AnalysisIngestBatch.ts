import { constants, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { ingestAnalysis } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';

const [mode, output, ...sources] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !sources.length) {
  throw new Error('Usage: dry-run|apply NEW_REPORT.json RESULT.json...');
}

const backup = createBackup();
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `analysis-ingest-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
}

const protectedTables = [
  'mail_item',
  'matter',
  'mail_matter_link',
  'work_item',
  'assignment',
  'action_item',
  'matter_note',
  'organization',
  'person',
  'matter_group',
  'matter_group_member',
  'matter_party',
  'user_feedback',
];
const digest = () => withDatabase(db => Object.fromEntries(protectedTables.map(table => [
  table,
  createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).digest('hex'),
])));
const before = digest();

const ingested = sources.map(source => {
  const input = JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
  const result = ingestAnalysis(input);
  return {
    source: path.resolve(source),
    runId: input.runId,
    coverageCount: input.coverage?.length ?? 0,
    candidateCount: input.candidates?.length ?? 0,
    result,
  };
});

if (JSON.stringify(before) !== JSON.stringify(digest())) {
  throw new Error('Protected business records changed');
}
const integrity = withDatabase(db => ({
  check: db.prepare('PRAGMA integrity_check').get(),
  foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
}));
if (JSON.stringify(integrity.check) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) {
  throw new Error('Integrity failed');
}

const report = {
  mode,
  backup: backup.file,
  clone,
  ingested,
  protectedTablesUnchanged: true,
  integrity,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({
  mode,
  output,
  runs: ingested.length,
  coverage: ingested.reduce((sum, item) => sum + item.coverageCount, 0),
  candidates: ingested.reduce((sum, item) => sum + item.candidateCount, 0),
  integrity,
}));
