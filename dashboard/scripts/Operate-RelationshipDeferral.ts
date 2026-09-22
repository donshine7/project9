import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { analysisStatus } from '../lib/analysis';
import { recordAuditFeedback } from '../lib/audit-feedback';
import { createBackup, withDatabase } from '../lib/work-db';

const [mode, output, rehearsalPath, expectedCountValue, authorization] = process.argv.slice(2);
const expectedCount = Number(expectedCountValue);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !Number.isInteger(expectedCount) || expectedCount < 1 || !authorization?.trim()) {
  throw new Error('Usage: dry-run|apply OUTPUT REHEARSAL_OR_DASH EXPECTED_COUNT AUTHORIZATION');
}
if (existsSync(output)) throw new Error('Report already exists');

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const protectedTables = [
  'mail_item', 'mail_matter_link', 'matter', 'matter_note', 'work_item', 'assignment', 'action_item',
  'organization', 'person', 'matter_party', 'matter_group', 'matter_group_member', 'wiki_entry', 'entity_wiki_revision',
];
const tableState = () => withDatabase(db => Object.fromEntries(
  protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
));
type RelationshipFinding = { matterRef: string; decisionId: string; reviewStatus: string; userAnswer: unknown; inheritedFeedback: boolean };
const targets = () => {
  const audit = analysisStatus().relationshipAudit;
  if (!audit) throw new Error('Relationship coverage audit not found');
  const findings: RelationshipFinding[] = audit.findings.map((finding: any) => ({
    matterRef: String(finding.matterRef),
    decisionId: String(finding.decisionId || ''),
    reviewStatus: String(finding.reviewStatus || ''),
    userAnswer: finding.userAnswer || null,
    inheritedFeedback: Boolean(finding.inheritedFeedback),
  }));
  if (findings.length !== expectedCount || findings.some(finding => !finding.decisionId)) {
    throw new Error(`Expected ${expectedCount} unambiguous findings, received ${findings.length}`);
  }
  return { runId: String(audit.runId), findings };
};

const answer = '현재 저장된 메일에는 회사·자연인과 사건상 역할을 직접 확정할 근거가 부족합니다. 새 직접 근거 또는 사용자 입력이 생기면 보완합니다.';
const backup = createBackup();
const preStateHash = digest(tableState());
const source = targets();
const sourceHash = digest(source);
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `relationship-deferral-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as {
    mode: string;
    preStateHash: string;
    sourceHash: string;
    protectedTablesUnchanged: boolean;
  };
  if (rehearsal.mode !== 'dry-run' || rehearsal.preStateHash !== preStateHash || rehearsal.sourceHash !== sourceHash || !rehearsal.protectedTablesUnchanged) {
    throw new Error('Operational state or relationship findings changed since rehearsal');
  }
}

const protectedBefore = digest(tableState());
const applied = targets().findings.map(finding => ({
  matterRef: finding.matterRef,
  ...recordAuditFeedback(finding.decisionId, { status: 'needs_follow_up', answer }),
}));
if (protectedBefore !== digest(tableState())) throw new Error('Protected business records changed');
const integrity = withDatabase(db => ({
  check: db.prepare('PRAGMA integrity_check').get(),
  foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
}));
if (JSON.stringify(integrity.check) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw new Error('Integrity failed');
const report = {
  mode, output, backup: backup.file, clone, authorization, runId: source.runId,
  findingCount: source.findings.length, answer, applied, preStateHash, sourceHash,
  protectedTablesUnchanged: true, integrity,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, applied: applied.length }));
