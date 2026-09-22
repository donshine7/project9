import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { reviewCandidate } from '../lib/analysis';
import { recordEasyPatVerification } from '../lib/easypat-verification';
import { createBackup, transaction, withDatabase } from '../lib/work-db';
import { finalizeWorkRefresh } from '../lib/work-refresh';
import { addWikiEntry } from '../lib/wiki';

type Row = Record<string, any>;

const [mode, output, rehearsalPath, authorization, refreshId] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !authorization?.trim() || !refreshId) {
  throw new Error('Usage: dry-run|apply OUTPUT REHEARSAL_OR_DASH AUTHORIZATION REFRESH_ID');
}
if (existsSync(output)) throw new Error('Report already exists');

const ids = {
  noAction: '4d47c335-d7c2-4b14-8582-7197510e8d15',
  applicationFact: 'a1b75a51-4b2b-4caf-880f-c76f625c1ca3',
  taiwanFact: 'e5b98603-e2d4-4ed6-a1a2-43a544bb2edd',
  applicationMail: 'f458ad6d-72d6-4537-986a-8dac4a05064c',
} as const;
const easyPatSummary = {
  tool: 'easypat_get_matter_summary',
  arguments: { matterReference: 'P261198' },
  structuredContent: {
    matterReference: 'P261198',
    rightType: '특허',
    applicationKind: '신규출원',
    applicationDivision: '등록출원',
    applicationDate: '2026-04-02',
    applicationNumber: '10-2026-0060022',
    titleKorean: '게임 사용자 상태 분석을 통한 맞춤형 콘텐츠 추천 장치 및 방법',
    status: '해외출원(1년) 마감',
  },
  observedAt: new Date().toISOString(),
} as const;

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const candidateState = () => withDatabase((db) => [ids.noAction, ids.applicationFact, ids.taiwanFact].map((id) => ({
  candidate: db.prepare('SELECT * FROM analysis_candidate WHERE id=?').get(id),
  decisions: db.prepare('SELECT * FROM decision_item WHERE subject_key=? ORDER BY id').all(id),
  verifications: db.prepare("SELECT * FROM analysis_candidate WHERE kind='risk' AND entity_id=? ORDER BY created_at,id").all(id),
})));
const sourceState = () => withDatabase((db) => ({
  candidates: candidateState(),
  matters: db.prepare("SELECT * FROM matter WHERE our_ref IN ('P211759-PCT-EP','P261198','T251582-TW') ORDER BY our_ref").all(),
  mail: db.prepare('SELECT * FROM mail_item WHERE id=?').get(ids.applicationMail),
  links: db.prepare('SELECT * FROM mail_matter_link WHERE mail_id=? ORDER BY matter_id').all(ids.applicationMail),
  entries: db.prepare(`SELECT w.* FROM wiki_entry w JOIN matter m ON m.id=w.entity_id AND w.entity_type='matter' WHERE m.our_ref IN ('P261198','T251582-TW') ORDER BY w.rowid`).all(),
  easyPatRuns: db.prepare("SELECT id,result_json FROM decision_run WHERE operation='easypat_source_verification' ORDER BY id").all(),
  refresh: db.prepare('SELECT * FROM work_refresh_run WHERE id=?').get(refreshId),
}));
const protectedState = () => withDatabase((db) => Object.fromEntries(
  ['mail_item','matter_note','work_item','assignment','action_item','organization','person','matter_party','matter_group','matter_group_member']
    .map((table) => [table, hash(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]),
));
const matterGuardState = () => withDatabase((db) => ({
  target: db.prepare("SELECT * FROM matter WHERE our_ref='T251582-TW' AND archived_at IS NULL").get() as Row | undefined,
  othersHash: hash(db.prepare("SELECT * FROM matter WHERE our_ref<>'T251582-TW' ORDER BY rowid").all()),
}));
const integrity = () => withDatabase((db) => ({
  check: db.prepare('PRAGMA integrity_check').get(),
  foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
}));

const backup = createBackup();
const sourceHash = hash(sourceState());
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `user-clarifications-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as {
    mode: string;
    sourceHash: string;
    protectedBusinessRecordsUnchanged: boolean;
  };
  if (rehearsal.mode !== 'dry-run' || !rehearsal.protectedBusinessRecordsUnchanged || rehearsal.sourceHash !== sourceHash) {
    throw new Error('Operational state changed since rehearsal');
  }
}

const protectedBefore = hash(protectedState());
const matterBefore = matterGuardState();
const rejectionReasons: Record<string, string> = {
  [ids.noAction]: `${authorization} P211759-PCT-EP Action은 생성하지 않는다.`,
  [ids.applicationFact]: `${authorization} 메일의 불완전한 출원번호 표기를 임의 정규화하지 않고 EasyPAT 원본으로 P261198/10-2026-0060022를 확인해 별도 기록한다.`,
  [ids.taiwanFact]: `${authorization} T251582-TW는 대만 사건이고 메일 본문의 베트남 표기는 오기이므로 사용자 확정 기록으로 대체한다.`,
};
const rejected = [ids.noAction, ids.applicationFact, ids.taiwanFact].map((id) => {
  const row = withDatabase((db) => db.prepare('SELECT review_status,row_version FROM analysis_candidate WHERE id=?').get(id) as Row | undefined);
  if (!row || row.review_status !== 'pending') throw new Error(`Candidate is not pending: ${id}`);
  return reviewCandidate(id, { action: 'reject', expectedVersion: row.row_version, reason: rejectionReasons[id] });
});

const easyPatRecord = recordEasyPatVerification(easyPatSummary);
if (easyPatRecord.matterReference !== 'P261198') throw new Error('EasyPAT matter identity mismatch');

const linked = withDatabase((db) => transaction(db, () => {
  const matter = db.prepare("SELECT * FROM matter WHERE our_ref='P261198' AND archived_at IS NULL").get() as Row | undefined;
  const mail = db.prepare('SELECT * FROM mail_item WHERE id=?').get(ids.applicationMail) as Row | undefined;
  if (!matter || !mail) throw new Error('P261198 matter or source mail missing');
  const otherLinks = db.prepare('SELECT matter_id FROM mail_matter_link WHERE mail_id=?').all(ids.applicationMail) as Row[];
  if (otherLinks.length) throw new Error('Application-number mail is already linked');
  const timestamp = new Date().toISOString();
  db.prepare("INSERT INTO mail_matter_link(mail_id,matter_id,match_source,confidence,created_at) VALUES (?,?,'easy_pat',1,?)")
    .run(ids.applicationMail, matter.id, timestamp);
  const eventId = randomUUID();
  const finalValue = {
    mailId: ids.applicationMail,
    matterRef: 'P261198',
    applicationNumber: '10-2026-0060022',
    easyPatSourceId: easyPatRecord.sourceId,
  };
  db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at)
    VALUES (?,'matter',?,'mail.linked_by_application_number',?,'Codex','easy_pat',?,?)`)
    .run(eventId, matter.id, JSON.stringify(finalValue), ids.applicationFact, timestamp);
  const decisionId = randomUUID();
  db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at)
    VALUES (?,?, 'matter',?,'mail.link','link',?,?,1,'medium','EasyPAT 원본의 출원번호·발명명칭·출원일이 메일과 일치','accepted',?)`)
    .run(decisionId, easyPatRecord.runId, matter.id, JSON.stringify(finalValue), JSON.stringify(finalValue), timestamp);
  const excerpt = `${mail.subject}\n특허출원번호 : 특허-2026-0060022\n발명의 명칭 : 게임 사용자 상태 분석을 통한 맞춤형 콘텐츠 추천 장치 및 방법`;
  db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports)
    VALUES (?,?, 'mail',?,? ,?,?,'support')`)
    .run(randomUUID(), decisionId, ids.applicationMail, JSON.stringify({ field: 'body_text' }), excerpt, hash(excerpt));
  db.prepare(`INSERT INTO user_feedback(id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,created_at)
    VALUES (?,?,?,'장진태','create_missing','null',?,'new_evidence',?,?)`)
    .run(randomUUID(), decisionId, eventId, JSON.stringify(finalValue), authorization, timestamp);
  return { eventId, decisionId, matterId: matter.id, matterVersion: matter.row_version };
}));

const taiwan = withDatabase((db) => transaction(db, () => {
  const matter = db.prepare("SELECT * FROM matter WHERE our_ref='T251582-TW' AND archived_at IS NULL").get() as Row | undefined;
  if (!matter || ![null, 'TW'].includes(matter.country_code)) throw new Error('T251582-TW matter identity mismatch');
  const timestamp = new Date().toISOString();
  const eventId = randomUUID();
  const finalValue = { matterRef: 'T251582-TW', countryCode: 'TW', country: '대만', typo: '베트남' };
  db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at)
    VALUES (?,'matter',?,'matter.country_confirmed',?,'장진태','user_input',?,?)`)
    .run(eventId, matter.id, JSON.stringify(finalValue), ids.taiwanFact, timestamp);
  db.prepare(`UPDATE matter
    SET country_code='TW',source_type='user_input',source_id=?,confidence=1,user_confirmed=1,
        row_version=row_version+1,updated_at=?
    WHERE id=?`)
    .run(eventId, timestamp, matter.id);
  db.prepare(`INSERT INTO source_observation(id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,observed_at,confidence,user_confirmed)
    VALUES (?,'matter',?,'country_code',?,'user_input',?,?,1,1)`)
    .run(randomUUID(), matter.id, JSON.stringify('TW'), eventId, timestamp);
  db.prepare(`INSERT INTO user_feedback(id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,created_at)
    VALUES (? ,?,'장진태','create_missing','null',?,'new_evidence',?,?)`)
    .run(randomUUID(), eventId, JSON.stringify(finalValue), authorization, timestamp);
  return { eventId, matterId: matter.id, matterVersion: matter.row_version + 1, updatedAt: timestamp };
}));

const p261198Entry = addWikiEntry('matter', linked.matterId, {
  content: 'EasyPAT 원본 및 메일 대조: P261198은 출원번호 10-2026-0060022, 출원일 2026-04-02, 발명의 명칭 "게임 사용자 상태 분석을 통한 맞춤형 콘텐츠 추천 장치 및 방법"인 특허 사건이다. 2026-09-18 메일에서 TIPS 과제 사사문구와 서지사항의 신속한 보정 반영을 요청했다.',
  entryDate: '2026-09-18',
  expectedVersion: linked.matterVersion,
  reason: `${authorization} EasyPAT 원본 확인으로 출원번호 메일을 P261198에 연결함.`,
});
const taiwanEntry = addWikiEntry('matter', taiwan.matterId, {
  content: '사용자 확정: T251582-TW는 대만 상표 사건이며, 2026-09-18 메일 본문의 "베트남상표출원" 표기는 오기이다. 메일에는 등록료 납부마감일 2026-11-15 및 진행 여부 회신 요청일 2026-10-15가 기재되어 있다.',
  entryDate: '2026-09-18',
  expectedVersion: taiwan.matterVersion,
  reason: `${authorization} TW는 대만이고 베트남 표기는 오기로 확정함.`,
});

const final = finalizeWorkRefresh(refreshId);
if (protectedBefore !== hash(protectedState())) throw new Error('Protected business records changed');
const matterAfter = matterGuardState();
if (!matterBefore.target || matterBefore.othersHash !== matterAfter.othersHash || !matterAfter.target) throw new Error('Unexpected matter mutation');
const expectedMatter = {
  ...matterBefore.target,
  country_code: 'TW',
  source_type: 'user_input',
  source_id: taiwan.eventId,
  confidence: 1,
  user_confirmed: 1,
  row_version: matterBefore.target.row_version + 1,
  updated_at: taiwan.updatedAt,
};
if (JSON.stringify(expectedMatter) !== JSON.stringify(matterAfter.target)) throw new Error('T251582-TW mutation exceeded user confirmation');
const checked = integrity();
if (JSON.stringify(checked.check) !== '{"integrity_check":"ok"}' || checked.foreignKeys.length) throw new Error('Integrity failed');
const post = withDatabase((db) => ({
  rejected: [ids.noAction, ids.applicationFact, ids.taiwanFact].map((id) => db.prepare('SELECT id,review_status,row_version,applied_event_id FROM analysis_candidate WHERE id=?').get(id)),
  link: db.prepare('SELECT l.*,m.our_ref FROM mail_matter_link l JOIN matter m ON m.id=l.matter_id WHERE l.mail_id=?').get(ids.applicationMail),
  entries: db.prepare('SELECT id,entity_id,entry_date,content,provenance FROM wiki_entry WHERE id IN (?,?) ORDER BY id').all(p261198Entry.entryId, taiwanEntry.entryId),
  actionCount: db.prepare("SELECT count(*) n FROM action_item a JOIN matter m ON m.id=a.matter_id WHERE m.our_ref='P211759-PCT-EP' AND a.archived_at IS NULL").get(),
  refresh: db.prepare('SELECT * FROM work_refresh_run WHERE id=?').get(refreshId),
}));
const report = {
  mode,
  output,
  backup: backup.file,
  clone,
  authorization,
  sourceHash,
  rejected,
  easyPatRecord,
  linked,
  taiwan,
  wikiEntries: [p261198Entry, taiwanEntry],
  final,
  post,
  protectedBusinessRecordsUnchanged: true,
  integrity: checked,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({
  mode,
  output,
  rejected: rejected.length,
  easyPatMatterReference: easyPatRecord.matterReference,
  linkedMatterReference: post.link?.our_ref,
  wikiEntryCount: post.entries.length,
  p211759ActionCount: post.actionCount?.n,
  refreshStatus: post.refresh?.status,
  pendingMailCount: post.refresh?.pending_mail_count,
  integrity: checked,
}));
