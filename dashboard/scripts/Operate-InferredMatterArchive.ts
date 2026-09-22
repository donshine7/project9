import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createBackup, withDatabase } from '../lib/work-db';

const [mode, output, rehearsalPath, authorization, verifierResultPath, matterRef] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !authorization?.trim() || !verifierResultPath || !matterRef) {
  throw new Error('Usage: dry-run|apply OUTPUT REHEARSAL_OR_DASH AUTHORIZATION VERIFIER_RESULT MATTER_REF');
}
if (existsSync(output)) throw new Error('Report already exists');

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const verifierResult = JSON.parse(readFileSync(verifierResultPath, 'utf8').replace(/^\uFEFF/, '')) as {
  runId: string;
  assessments?: Array<{ matterId: string; matterRef: string; verdict: string; confidence: number; rationale: string; evidence: unknown[] }>;
};
const assessment = verifierResult.assessments?.find(item => item.matterRef === matterRef);
if (!assessment || assessment.verdict !== 'archive' || assessment.confidence < 0.9 || !assessment.rationale || !assessment.evidence?.length) {
  throw new Error('A high-confidence archive assessment is required');
}

const protectedTables = [
  'mail_item', 'work_item', 'assignment', 'action_item', 'matter_note', 'organization', 'person', 'matter_party',
  'matter_group', 'matter_group_member', 'source_observation', 'input_snapshot', 'policy_revision', 'decision_run',
  'decision_item', 'user_feedback', 'decision_comparison', 'analysis_candidate', 'knowledge_entry', 'wiki_entry', 'entity_wiki_revision',
];
const state = () => withDatabase(db => ({
  protected: Object.fromEntries(protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  matters: db.prepare('SELECT * FROM matter ORDER BY rowid').all(),
  links: db.prepare('SELECT * FROM mail_matter_link ORDER BY rowid').all(),
  events: db.prepare('SELECT * FROM event ORDER BY rowid').all(),
}));
const dependencyState = (matterId: string) => withDatabase(db => ({
  work: db.prepare('SELECT id FROM work_item WHERE matter_id=?').all(matterId),
  action: db.prepare('SELECT id FROM action_item WHERE matter_id=?').all(matterId),
  note: db.prepare('SELECT id FROM matter_note WHERE matter_id=?').all(matterId),
  party: db.prepare('SELECT party_id,role FROM matter_party WHERE matter_id=?').all(matterId),
  groupMember: db.prepare('SELECT group_id FROM matter_group_member WHERE matter_id=?').all(matterId),
  groupRepresentative: db.prepare('SELECT id FROM matter_group WHERE representative_matter_id=?').all(matterId),
  knowledge: db.prepare("SELECT id FROM knowledge_entry WHERE entity_type='matter' AND entity_id=?").all(matterId),
  wikiEntry: db.prepare("SELECT id FROM wiki_entry WHERE entity_type='matter' AND entity_id=?").all(matterId),
  wikiRevision: db.prepare("SELECT id FROM entity_wiki_revision WHERE entity_type='matter' AND entity_id=?").all(matterId),
}));

const backup = createBackup();
let clone: string | null = null;
const preState = state();
const baselineHash = hash(preState);
const verifierHash = hash(verifierResult);
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `matter-archive-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as {
    mode: string;
    baselineHash: string;
    verifierHash: string;
    protectedDataUnchanged: boolean;
  };
  if (rehearsal.mode !== 'dry-run' || !rehearsal.protectedDataUnchanged
    || rehearsal.baselineHash !== baselineHash || rehearsal.verifierHash !== verifierHash) {
    throw new Error('Operational state or verifier result changed since rehearsal');
  }
}

const result = withDatabase(db => {
  const matter = db.prepare('SELECT * FROM matter WHERE our_ref=? AND archived_at IS NULL').get(matterRef) as { id: string; user_confirmed: number; row_version: number } | undefined;
  if (!matter || matter.id !== assessment.matterId || matter.user_confirmed !== 0) throw new Error('Target is stale, different, or user-confirmed');
  const run = db.prepare('SELECT status,model,reasoning_effort FROM decision_run WHERE id=?').get(verifierResult.runId) as { status: string; model: string; reasoning_effort: string } | undefined;
  if (!run || run.status !== 'succeeded' || run.model !== 'gpt-5.6-sol' || run.reasoning_effort !== 'high') throw new Error('Completed Sol/high verification run is required');
  const dependencies = dependencyState(matter.id);
  if (Object.values(dependencies).some(rows => rows.length)) throw new Error(`Matter has protected dependencies: ${JSON.stringify(dependencies)}`);
  const oldLinks = db.prepare('SELECT * FROM mail_matter_link WHERE matter_id=? ORDER BY rowid').all(matter.id);
  const at = new Date().toISOString();
  const eventId = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM mail_matter_link WHERE matter_id=?').run(matter.id);
    const changed = db.prepare('UPDATE matter SET archived_at=?,updated_at=?,row_version=row_version+1 WHERE id=? AND archived_at IS NULL AND row_version=?').run(at, at, matter.id, matter.row_version);
    if (changed.changes !== 1) throw new Error('Matter version conflict');
    db.prepare(`
      INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at)
      VALUES (?,'matter',?,'matter.inference_archived',?,?,'Codex','analysis',?,?)
    `).run(eventId, matter.id, JSON.stringify({ archivedAt: null, linkedMailIds: oldLinks.map(link => link.mail_id) }), JSON.stringify({
      archivedAt: at,
      meaning: '자동추론을 활성 목록에서 제외함. 사건의 부존재·완료를 확정하지 않음.',
      authorization,
      verifierRunId: verifierResult.runId,
      assessment,
    }), verifierResult.runId, at);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { matterId: matter.id, matterRef, removedLinks: oldLinks.length, eventId, archivedAt: at, dependencies };
});

const after = state();
if (hash(preState.protected) !== hash(after.protected)) throw new Error('Protected data changed');
const beforeMatters = preState.matters as Array<Record<string, unknown> & { id: string; row_version: number }>;
const afterMatters = after.matters as Array<Record<string, unknown> & { id: string; row_version: number; archived_at?: string }>;
const beforeLinks = preState.links as Array<Record<string, unknown> & { matter_id: string }>;
const afterLinks = after.links as Array<Record<string, unknown> & { matter_id: string }>;
const unchangedMatters = beforeMatters.filter(item => item.id !== result.matterId);
const unchangedLinks = beforeLinks.filter(item => item.matter_id !== result.matterId);
const targetAfter = afterMatters.find(item => item.id === result.matterId);
const targetBefore = beforeMatters.find(item => item.id === result.matterId);
if (!targetAfter?.archived_at || targetAfter.row_version !== (targetBefore?.row_version ?? 0) + 1
  || hash(unchangedMatters) !== hash(afterMatters.filter(item => item.id !== result.matterId))
  || hash(unchangedLinks) !== hash(afterLinks)
  || after.events.length !== preState.events.length + 1
  || preState.events.some(event => !after.events.some(candidate => hash(candidate) === hash(event)))) {
  throw new Error('Unexpected archive mutation');
}
const integrity = withDatabase(db => ({ check: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));
if (integrity.check?.integrity_check !== 'ok' || integrity.foreignKeys.length) throw new Error('Integrity failed');
const report = {
  mode, output, backup: backup.file, clone, authorization, verifierResultPath, verifierRunId: verifierResult.runId,
  baselineHash, verifierHash, protectedDataUnchanged: true, result, integrity,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
