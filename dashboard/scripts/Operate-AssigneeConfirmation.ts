import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createBackup, transaction, withDatabase } from '../lib/work-db';

const [mode, output, rehearsalPath, matterRef, decisionId, assignee, authorization] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !matterRef || !decisionId || !assignee || !authorization) {
  throw new Error('Usage: dry-run|apply OUTPUT REHEARSAL_OR_DASH MATTER_REF DECISION_ID ASSIGNEE AUTHORIZATION');
}
if (existsSync(output)) throw new Error('Report already exists');

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const protectedTables = [
  'mail_item', 'mail_matter_link', 'work_item', 'assignment', 'action_item',
  'organization', 'person', 'matter_party', 'matter_group', 'matter_group_member',
];
const state = () => withDatabase(db => Object.fromEntries(
  ['matter', 'matter_note', 'event', 'decision_item', 'user_feedback', 'decision_comparison', ...protectedTables]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
));
const protectedState = () => withDatabase(db => Object.fromEntries(
  protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
));
const target = () => withDatabase(db => {
  const matter = db.prepare('SELECT * FROM matter WHERE our_ref=? COLLATE NOCASE AND archived_at IS NULL').get(matterRef) as Record<string, unknown> | undefined;
  const decision = db.prepare(`
    SELECT d.*,r.operation
    FROM decision_item d
    JOIN decision_run r ON r.id=d.decision_run_id
    WHERE d.id=?
  `).get(decisionId) as Record<string, unknown> | undefined;
  if (!matter) throw new Error(`Matter not found: ${matterRef}`);
  if (!decision || decision.operation !== 'action_judgement' || decision.field_path !== 'coverage.outcome') {
    throw new Error('Target is not an Action judgement coverage decision');
  }
  if (decision.normalized_value_json !== JSON.stringify('needs_review')) throw new Error('Target decision is not needs_review');
  return { matter, decision };
});

const backup = createBackup();
const preStateHash = hash(state());
const sourceHash = hash(target());
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `assignee-confirmation-dry-${randomUUID()}.db`);
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
    throw new Error('Operational state or source decision changed since rehearsal');
  }
}

const protectedBefore = hash(protectedState());
const result = withDatabase(db => transaction(db, () => {
  const { matter, decision } = target();
  const matterId = String(matter.id);
  const finalValue = {
    matterRef,
    workType: '중간사건',
    task: '최초 거절결정 대응용 보정안·의견서 작성 및 제출',
    role: 'assignee1',
    assignee,
    source: 'user_input',
  };
  const serializedFinal = JSON.stringify(finalValue);
  const prior = db.prepare('SELECT * FROM user_feedback WHERE decision_item_id=? AND final_value_json=? ORDER BY created_at DESC LIMIT 1')
    .get(decisionId, serializedFinal) as Record<string, unknown> | undefined;
  if (prior) return { duplicate: true, matterId, decisionId, feedbackId: prior.id, finalValue };

  const timestamp = stamp();
  const noteContent = `사용자 확인(${timestamp.slice(0, 10)}): ${finalValue.task}의 실제 담당자1은 ${assignee}.`;
  const noteId = randomUUID();
  const noteEventId = randomUUID();
  const confirmationEventId = randomUUID();
  const feedbackId = randomUUID();
  db.prepare(`INSERT INTO matter_note(id,matter_id,note_type,content,author,created_at,updated_at) VALUES (?,?,'user',?,'장진태',?,?)`)
    .run(noteId, matterId, noteContent, timestamp, timestamp);
  db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at) VALUES (?,'matter_note',?,'note_created',NULL,?,'장진태','user_input',?,?)`)
    .run(noteEventId, noteId, JSON.stringify({ matterId, content: noteContent }), confirmationEventId, timestamp);
  db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at) VALUES (?,'matter',?,'assignment.user_confirmed',?,?, '장진태','user_input',?,?)`)
    .run(confirmationEventId, matterId, JSON.stringify({ assignee: null }), serializedFinal, decisionId, timestamp);
  db.prepare(`INSERT INTO user_feedback(id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,new_evidence_ids_json,created_at) VALUES (?,?,?,'장진태','create_missing',?,?,'new_evidence',?,'[]',?)`)
    .run(feedbackId, decisionId, confirmationEventId, String(decision.proposed_value_json), serializedFinal, authorization, timestamp);
  db.prepare(`INSERT INTO decision_comparison(id,user_feedback_id,comparison_type,changed_paths_json,model_error_class,eligible_for_eval,excluded_reason,compared_at) VALUES (?,?,'different',?,'unknown',0,'사용자가 누락된 담당자 근거를 새로 제공함',?)`)
    .run(randomUUID(), feedbackId, JSON.stringify(['assignee']), timestamp);
  db.prepare("UPDATE decision_item SET review_status='accepted' WHERE id=?").run(decisionId);
  db.prepare('UPDATE matter SET updated_at=?,row_version=row_version+1 WHERE id=?').run(timestamp, matterId);
  return { duplicate: false, matterId, decisionId, feedbackId, noteId, eventId: confirmationEventId, finalValue };
}));

if (protectedBefore !== hash(protectedState())) throw new Error('Protected business records changed');
const integrity = withDatabase(db => ({
  check: db.prepare('PRAGMA integrity_check').get(),
  foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
}));
if (JSON.stringify(integrity.check) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw new Error('Integrity failed');
const report = {
  mode, output, backup: backup.file, clone, matterRef, decisionId, assignee, authorization,
  result, preStateHash, sourceHash, protectedTablesUnchanged: true, integrity,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify(report));
