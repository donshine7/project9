import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createBackup, importConfirmedMatterGroups } from '../lib/work-db';

const planPath = process.argv[2];
const workbookPath = process.argv[3];

if (!planPath || !workbookPath) {
  throw new Error('Usage: Apply-ConfirmedGroups <plan.json> <workbook.xlsx>');
}

const plan = JSON.parse(readFileSync(path.resolve(planPath), 'utf8'));
const workbook = readFileSync(path.resolve(workbookPath));
const sourceHash = createHash('sha256').update(workbook).digest('hex');
if (String(plan.sourceHash).toLowerCase() !== sourceHash) {
  throw new Error('The workbook changed after review. Rebuild the group plan from a fresh snapshot.');
}

const workbookStat = statSync(path.resolve(workbookPath));
const backup = createBackup();
const result = importConfirmedMatterGroups({
  ...plan,
  sourceHash,
  sourceLastModified: workbookStat.mtime.toISOString(),
});

process.stdout.write(JSON.stringify({ backup: backup.file, ...result }, null, 2));
