import { constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseMatterNumber } from '../lib/matter-number';
import { createBackup, transaction, withDatabase } from '../lib/work-db';

const [mode, output, rehearsalPath, evidencePath, authorization] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !evidencePath || !authorization?.trim()) {
  throw new Error('Usage: dry-run|apply OUTPUT REHEARSAL_OR_DASH OUTLOOK_EVIDENCE_JSON AUTHORIZATION');
}
if (existsSync(output)) throw new Error('Report already exists');

type OutlookRecord = {
  entryId?: string;
  internetMessageId?: string;
  folderPath?: string;
  direction?: string;
  subject?: string;
  mailAt?: string;
  body?: string;
};

const WORKBOOK_HASH = 'd4cadc47284a0b062f416f07b2dbe332881206e2ee05a49139d4941a2647912d';
const YBK_FEEDBACK_ID = 'c68c4de9-9aa0-4009-8569-102fcf785f1b';
const YBK_REVIEW_KEY = 'ybk-missing-trademark-numbers';
const NAM_REVIEW_KEY = 'namgiseon-missing-trademark-numbers';
const YBK_SUBJECT = '[업무전달] 사건등록 및 견적서 완료[P241750외2건, T241498외1건/주식회사 와이비케이코퍼레이션]';
const NAM_SUBJECT = '[업무전달]사건등록 및 견적서 송부 완료[T251093, T251094/남기선]';
const stamp = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidenceDocument = JSON.parse(readFileSync(evidencePath, 'utf8')) as { records?: OutlookRecord[] };

function outlookEvidence(subject: string, requiredPhrases: string[]) {
  const record = (evidenceDocument.records || []).find(candidate => candidate.subject === subject);
  if (!record) throw new Error(`Outlook evidence not found: ${subject}`);
  const text = `${record.subject || ''}\n${record.body || ''}`;
  for (const phrase of requiredPhrases) {
    if (!text.includes(phrase)) throw new Error(`Outlook evidence is missing required phrase: ${phrase}`);
  }
  const sourceId = String(record.internetMessageId || record.entryId || '').trim();
  if (!sourceId) throw new Error(`Outlook evidence has no stable source id: ${subject}`);
  return {
    sourceId,
    entryId: String(record.entryId || ''),
    internetMessageId: String(record.internetMessageId || ''),
    folderPath: String(record.folderPath || ''),
    direction: String(record.direction || ''),
    subject: String(record.subject || ''),
    mailAt: String(record.mailAt || ''),
    bodyHash: createHash('sha256').update(String(record.body || '')).digest('hex'),
  };
}

const ybkMail = outlookEvidence(YBK_SUBJECT, [
  'P241750', 'T241498', 'T241499',
  '상표 가출원 2건 : T241498, T241499 (지원사업증빙용)',
]);
const namMail = outlookEvidence(NAM_SUBJECT, [
  'T251093', 'T251094', 'P241667 패키지로 진행되는 건으로 관납료만 받고 진행',
]);

const ybkMembers = ['P241750-RE', 'PT241172', 'PT241173', 'T241498', 'T241499'];
const namMembers = [
  'P241667', 'P241667-DIV1', 'P241667-DIV2',
  'PT241110', 'PT241111', 'PT241112', 'T251093', 'T251094',
];
const allRefs = [...ybkMembers, ...namMembers];

const plans = [
  {
    groupRef: 'GP241750-RE',
    groupType: '정부지원사업',
    representativeRef: 'P241750-RE',
    members: ybkMembers,
    note: '와이비케이코퍼레이션 정부지원사업 묶음. 사용자 확정 원사건 P241750-RE, Excel 근거 가출원 PT241172~PT241173, 사건등록 메일에 지원사업증빙용으로 명시된 상표 T241498~T241499를 연결함.',
    reviewKey: YBK_REVIEW_KEY,
    mail: ybkMail,
    excerpt: '상표 가출원 2건 : T241498, T241499 (지원사업증빙용)',
  },
  {
    groupRef: 'GP241667',
    groupType: '정부지원사업',
    representativeRef: 'P241667',
    members: namMembers,
    note: '남기선 지원사업 묶음. 완료된 메이킹 본건, 분할 2건, 지원사업용 가출원 3건 및 P241667 패키지로 명시된 상표 T251093~T251094를 연결함.',
    reviewKey: NAM_REVIEW_KEY,
    mail: namMail,
    excerpt: '상표 신규출원 2건 : T251093~T251094. P241667 패키지로 진행되는 건으로 관납료만 받고 진행.',
  },
];

const protectedTables = [
  'mail_item', 'mail_matter_link', 'work_item', 'assignment', 'action_item', 'matter_note',
  'organization', 'person', 'matter_party', 'wiki_entry', 'entity_wiki_revision',
];
const protectedState = () => withDatabase(db => Object.fromEntries(
  protectedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
));
const targetState = () => withDatabase(db => {
  const refs = allRefs.map(() => '?').join(',');
  return {
    matters: db.prepare(`SELECT * FROM matter WHERE archived_at IS NULL AND our_ref IN (${refs}) ORDER BY our_ref`).all(...allRefs),
    groups: db.prepare(`
      SELECT g.*,r.our_ref AS representative_ref,group_concat(m.our_ref, ',') AS members
      FROM matter_group g
      LEFT JOIN matter r ON r.id=g.representative_matter_id
      LEFT JOIN matter_group_member gm ON gm.group_id=g.id
      LEFT JOIN matter m ON m.id=gm.matter_id
      WHERE g.archived_at IS NULL AND g.group_ref IN ('GP241750-RE','GP241667')
      GROUP BY g.id ORDER BY g.group_ref
    `).all(),
    reviews: db.prepare(`
      SELECT d.*,r.operation
      FROM decision_item d JOIN decision_run r ON r.id=d.decision_run_id
      WHERE r.operation='group_candidate_review' AND d.subject_key IN (?,?)
      ORDER BY d.subject_key
    `).all(YBK_REVIEW_KEY, NAM_REVIEW_KEY),
    ybkFeedback: db.prepare('SELECT * FROM user_feedback WHERE id=?').get(YBK_FEEDBACK_ID),
  };
});

function validateSourceState() {
  return withDatabase(db => {
    const reviews = db.prepare(`
      SELECT d.id,d.subject_key,d.review_status
      FROM decision_item d JOIN decision_run r ON r.id=d.decision_run_id
      WHERE r.operation='group_candidate_review' AND d.subject_key IN (?,?)
      ORDER BY d.subject_key
    `).all(YBK_REVIEW_KEY, NAM_REVIEW_KEY) as Array<{ id: string; subject_key: string; review_status: string }>;
    if (reviews.length !== 2 || reviews.some(review => !['needs_user_input', 'accepted'].includes(review.review_status))) {
      throw new Error('Expected two unresolved or already accepted group review decisions');
    }
    const feedback = db.prepare('SELECT id,final_value_json FROM user_feedback WHERE id=?').get(YBK_FEEDBACK_ID) as { id?: string; final_value_json?: string } | undefined;
    if (!feedback?.id || !String(feedback.final_value_json).includes('P241750-RE')) {
      throw new Error('YBK user-confirmed P241750-RE evidence is missing');
    }
    const nam = db.prepare(`
      SELECT g.id,g.group_type,r.our_ref AS representative_ref
      FROM matter_group g LEFT JOIN matter r ON r.id=g.representative_matter_id
      WHERE g.group_ref='GP241667' AND g.archived_at IS NULL
    `).get() as { id?: string; group_type?: string; representative_ref?: string } | undefined;
    if (!nam?.id || nam.group_type !== '정부지원사업' || nam.representative_ref !== 'P241667') {
      throw new Error('Existing GP241667 state differs from the confirmed plan');
    }
    return { reviews, feedbackId: feedback.id, namGroupId: nam.id };
  });
}

const backup = createBackup();
const preStateHash = digest({ protected: protectedState(), target: targetState() });
const source = {
  plans,
  workbook: {
    sourceName: '나의업무관리.xlsx',
    sha256: WORKBOOK_HASH,
    ybkRange: '2026!B381:M402',
    namRange: '2026!B378:M378',
  },
  ybkUserFeedbackId: YBK_FEEDBACK_ID,
  state: validateSourceState(),
};
const sourceHash = digest(source);
let clone: string | null = null;

if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `trademark-group-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as {
    mode?: string;
    preStateHash?: string;
    sourceHash?: string;
    protectedTablesUnchanged?: boolean;
  };
  if (rehearsal.mode !== 'dry-run' || rehearsal.preStateHash !== preStateHash
      || rehearsal.sourceHash !== sourceHash || !rehearsal.protectedTablesUnchanged) {
    throw new Error('Operational state or evidence changed since rehearsal');
  }
}

const protectedBefore = digest(protectedState());
const result = withDatabase(db => transaction(db, () => {
  const current = validateSourceState();
  const timestamp = stamp();
  const runId = randomUUID();
  const snapshotId = randomUUID();
  const policyId = 'trademark-group-completion-v1';
  const policyHash = createHash('sha256')
    .update('trademark-group-completion-v1:direct-registration-mail+user-confirmation+excel')
    .digest('hex');
  const contextJson = JSON.stringify(source);
  const contextHash = createHash('sha256').update(contextJson).digest('hex');
  const entityVersions: Record<string, number> = {};
  for (const row of db.prepare(`
    SELECT id,row_version FROM matter WHERE archived_at IS NULL AND our_ref IN (${allRefs.map(() => '?').join(',')})
  `).all(...allRefs) as Array<{ id: string; row_version: number }>) {
    entityVersions[`matter:${row.id}`] = row.row_version;
  }
  for (const row of db.prepare(`
    SELECT id,row_version FROM matter_group WHERE archived_at IS NULL AND group_ref IN ('GP241750-RE','GP241667')
  `).all() as Array<{ id: string; row_version: number }>) {
    entityVersions[`group:${row.id}`] = row.row_version;
  }

  db.prepare(`
    INSERT OR IGNORE INTO policy_revision(
      id,revision_type,version,artifact_paths_json,content_hash,status,created_at
    ) VALUES (?,'workflow','trademark-group-completion-v1',? ,?,'active',?)
  `).run(policyId, JSON.stringify([
    'docs/WORK_MANAGEMENT_ARCHITECTURE.md',
    'docs/RELATIONSHIP_AND_GROUP_REVIEW_2026-09-17.md',
  ]), policyHash, timestamp);
  db.prepare(`
    INSERT INTO input_snapshot(
      id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at
    ) VALUES (?,?,?,'user-confirmation+direct-registration-mail+excel-v1',?,?,?)
  `).run(
    snapshotId,
    JSON.stringify([ybkMail.sourceId, namMail.sourceId]),
    JSON.stringify(entityVersions),
    contextHash,
    contextJson,
    timestamp,
  );
  db.prepare(`
    INSERT INTO decision_run(
      id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,
      input_snapshot_id,status,started_at,execution_ref
    ) VALUES (?,'trademark_group_completion','deterministic_group_reconciler',
      'trademark-group-completion-v1',?,? ,?,'started',?,?)
  `).run(
    runId,
    policyId,
    JSON.stringify({ method: 'deterministic', model: null, effort: null }),
    snapshotId,
    timestamp,
    authorization,
  );

  const matterIds = new Map<string, string>();
  let createdMatters = 0;
  const provenance = (ref: string) => {
    if (ref === 'P241750-RE') return { sourceType: 'user_input', sourceId: YBK_FEEDBACK_ID, confidence: 1, userConfirmed: 1 };
    if (ref === 'PT241172' || ref === 'PT241173') {
      return {
        sourceType: 'excel',
        sourceId: `나의업무관리.xlsx@sha256:${WORKBOOK_HASH}#2026!B402:M402`,
        confidence: 0.98,
        userConfirmed: 0,
      };
    }
    if (ref === 'T241498' || ref === 'T241499') {
      return { sourceType: 'registration_mail', sourceId: ybkMail.sourceId, confidence: 0.99, userConfirmed: 0 };
    }
    if (ref === 'T251093' || ref === 'T251094') {
      return { sourceType: 'registration_mail', sourceId: namMail.sourceId, confidence: 0.99, userConfirmed: 0 };
    }
    throw new Error(`No creation provenance for missing matter: ${ref}`);
  };

  for (const ref of allRefs) {
    const existing = db.prepare('SELECT id FROM matter WHERE our_ref=? COLLATE NOCASE AND archived_at IS NULL')
      .get(ref) as { id?: string } | undefined;
    if (existing?.id) {
      matterIds.set(ref, existing.id);
      continue;
    }
    const parsed = parseMatterNumber(ref);
    const sourceInfo = provenance(ref);
    const id = randomUUID();
    db.prepare(`
      INSERT INTO matter(
        id,our_ref,office,matter_kind,country_code,base_ref,parent_ref,relation_type,
        suffixes_json,source_type,source_id,confidence,user_confirmed,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, parsed.normalized, parsed.office, parsed.kind, parsed.countryCode, parsed.baseRef,
      parsed.parentRef, parsed.relationType, JSON.stringify(parsed.suffixes), sourceInfo.sourceType,
      sourceInfo.sourceId, sourceInfo.confidence, sourceInfo.userConfirmed, timestamp, timestamp,
    );
    db.prepare(`
      INSERT INTO event(
        id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at
      ) VALUES (?,'matter',?,'matter_created_from_group_completion',NULL,?,'Codex',?,?,?)
    `).run(
      randomUUID(), id,
      JSON.stringify({ ourRef: ref, sourceId: sourceInfo.sourceId, confidence: sourceInfo.confidence }),
      sourceInfo.sourceType, runId, timestamp,
    );
    matterIds.set(ref, id);
    createdMatters += 1;
  }

  let createdGroups = 0;
  let linkedMembers = 0;
  let updatedGroups = 0;
  const decisionIds: string[] = [];
  const evidenceIds: string[] = [];
  const reviewIds = new Map(current.reviews.map(review => [review.subject_key, review.id]));

  for (const plan of plans) {
    const representativeId = matterIds.get(plan.representativeRef)!;
    const existing = db.prepare(`
      SELECT g.id,g.group_type,g.representative_matter_id,g.note,g.row_version,r.our_ref AS representative_ref
      FROM matter_group g LEFT JOIN matter r ON r.id=g.representative_matter_id
      WHERE g.group_ref=? COLLATE NOCASE AND g.archived_at IS NULL
    `).get(plan.groupRef) as Record<string, unknown> | undefined;
    if (existing && (existing.group_type !== plan.groupType || existing.representative_ref !== plan.representativeRef)) {
      throw new Error(`${plan.groupRef} existing type or representative differs from plan`);
    }
    const groupId = String(existing?.id || randomUUID());
    if (!existing) {
      db.prepare(`
        INSERT INTO matter_group(
          id,group_ref,group_type,representative_matter_id,note,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?)
      `).run(groupId, plan.groupRef, plan.groupType, representativeId, plan.note, timestamp, timestamp);
      db.prepare(`
        INSERT INTO event(
          id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at
        ) VALUES (?,'group',?,'group_created_from_verified_evidence',NULL,?,'Codex','verified_evidence',?,?)
      `).run(randomUUID(), groupId, JSON.stringify({
        groupRef: plan.groupRef,
        groupType: plan.groupType,
        representativeRef: plan.representativeRef,
        note: plan.note,
      }), runId, timestamp);
      createdGroups += 1;
    } else if (String(existing.note || '') !== plan.note) {
      db.prepare(`
        UPDATE matter_group SET note=?,row_version=row_version+1,updated_at=? WHERE id=?
      `).run(plan.note, timestamp, groupId);
      db.prepare(`
        INSERT INTO event(
          id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at
        ) VALUES (?,'group',?,'group_note_updated',?,?, 'Codex','verified_evidence',?,?)
      `).run(
        randomUUID(), groupId, JSON.stringify({ note: existing.note }), JSON.stringify({ note: plan.note }),
        runId, timestamp,
      );
      updatedGroups += 1;
    }

    const previousMembers = existing
      ? (db.prepare(`
          SELECT m.our_ref FROM matter_group_member gm JOIN matter m ON m.id=gm.matter_id
          WHERE gm.group_id=? ORDER BY m.our_ref
        `).all(groupId) as Array<{ our_ref: string }>).map(row => row.our_ref)
      : [];
    for (const ref of plan.members) {
      const matterId = matterIds.get(ref)!;
      const linked = db.prepare(`
        INSERT OR IGNORE INTO matter_group_member(group_id,matter_id,created_at) VALUES (?,?,?)
      `).run(groupId, matterId, timestamp);
      if (Number(linked.changes) === 0) continue;
      const sourceType = ref.startsWith('T') ? 'registration_mail' : ref === 'P241750-RE' ? 'user_input' : 'excel';
      const sourceId = ref.startsWith('T') ? plan.mail.sourceId
        : ref === 'P241750-RE' ? YBK_FEEDBACK_ID
        : `나의업무관리.xlsx@sha256:${WORKBOOK_HASH}`;
      db.prepare(`
        INSERT INTO event(
          id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at
        ) VALUES (?,'matter',?,'group_linked_from_verified_evidence',NULL,?,'Codex',?,?,?)
      `).run(
        randomUUID(), matterId, JSON.stringify({ groupId, groupRef: plan.groupRef }),
        sourceType, runId, timestamp,
      );
      db.prepare(`
        INSERT INTO source_observation(
          id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,
          observed_at,confidence,user_confirmed
        ) VALUES (?,'matter',?,'groups.membership',?,?,?,?,?,?)
      `).run(
        randomUUID(), matterId, JSON.stringify(plan.groupRef), sourceType, sourceId,
        timestamp, ref === 'P241750-RE' ? 1 : ref.startsWith('T') ? 0.99 : 0.98,
        ref === 'P241750-RE' ? 1 : 0,
      );
      linkedMembers += 1;
    }

    const decisionId = randomUUID();
    const membersJson = JSON.stringify(plan.members);
    db.prepare(`
      INSERT INTO decision_item(
        id,decision_run_id,subject_type,subject_key,field_path,decision_type,previous_value_json,
        proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at
      ) VALUES (?,?,'group',?,'group.members',?,?,?,?,0.99,'medium',?,'accepted',?)
    `).run(
      decisionId, runId, groupId, existing ? 'update' : 'create', JSON.stringify(previousMembers),
      membersJson, membersJson,
      '사건등록 메일에 전체 상표 관리번호와 기존 정부지원사업 사건의 관계가 직접 명시됨',
      timestamp,
    );
    decisionIds.push(decisionId);
    const mailEvidenceId = randomUUID();
    db.prepare(`
      INSERT INTO decision_evidence(
        id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports
      ) VALUES (?,?,'outlook',?,?,?,?, 'support')
    `).run(
      mailEvidenceId, decisionId, plan.mail.sourceId,
      JSON.stringify({
        entryId: plan.mail.entryId,
        internetMessageId: plan.mail.internetMessageId,
        folderPath: plan.mail.folderPath,
        direction: plan.mail.direction,
        subject: plan.mail.subject,
        mailAt: plan.mail.mailAt,
        bodyHash: plan.mail.bodyHash,
      }),
      plan.excerpt,
      createHash('sha256').update(plan.excerpt).digest('hex'),
    );
    evidenceIds.push(mailEvidenceId);

    const reviewId = reviewIds.get(plan.reviewKey);
    if (!reviewId) throw new Error(`Review decision not found: ${plan.reviewKey}`);
    const review = db.prepare('SELECT proposed_value_json,normalized_value_json,review_status FROM decision_item WHERE id=?')
      .get(reviewId) as { proposed_value_json: string; normalized_value_json: string; review_status: string };
    const finalValue = JSON.stringify({
      status: 'resolved_from_direct_mail_evidence',
      groupRef: plan.groupRef,
      representativeRef: plan.representativeRef,
      members: plan.members,
      evidenceDecisionId: decisionId,
    });
    const duplicateFeedback = db.prepare(`
      SELECT id FROM user_feedback WHERE decision_item_id=? AND final_value_json=? LIMIT 1
    `).get(reviewId, finalValue) as { id?: string } | undefined;
    if (!duplicateFeedback?.id) {
      const reviewEventId = randomUUID();
      const feedbackId = randomUUID();
      db.prepare(`
        INSERT INTO event(
          id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at
        ) VALUES (?,'decision_item',?,'group_review_resolved_from_new_evidence',?,?, '장진태',
          'user_instruction',?,?)
      `).run(
        reviewEventId, reviewId, review.normalized_value_json, finalValue,
        runId, timestamp,
      );
      db.prepare(`
        INSERT INTO user_feedback(
          id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,
          reason_code,note,new_evidence_ids_json,created_at
        ) VALUES (?,?,?,'장진태','accept_with_new_evidence',?,?, 'new_evidence',?,?,?)
      `).run(
        feedbackId, reviewId, reviewEventId, review.proposed_value_json, finalValue,
        authorization, JSON.stringify([mailEvidenceId]), timestamp,
      );
      db.prepare(`
        INSERT INTO decision_comparison(
          id,user_feedback_id,comparison_type,changed_paths_json,model_error_class,
          eligible_for_eval,excluded_reason,compared_at
        ) VALUES (?,?,'different',?,'unknown',0,'새 Outlook 직접 근거로 미확정 번호를 보완함',?)
      `).run(
        randomUUID(), feedbackId,
        JSON.stringify(['knownMatterRefs', 'remainingQuestions', 'groupRef']),
        timestamp,
      );
    }
    db.prepare("UPDATE decision_item SET review_status='accepted' WHERE id=?").run(reviewId);
  }

  const runResult = {
    runId,
    createdMatters,
    createdGroups,
    updatedGroups,
    linkedMembers,
    decisionIds,
    evidenceIds,
    groups: plans.map(plan => ({ groupRef: plan.groupRef, members: plan.members })),
  };
  const resultJson = JSON.stringify(runResult);
  db.prepare(`
    UPDATE decision_run SET status='succeeded',completed_at=?,output_hash=?,result_json=? WHERE id=?
  `).run(stamp(), createHash('sha256').update(resultJson).digest('hex'), resultJson, runId);
  return runResult;
}));

if (protectedBefore !== digest(protectedState())) throw new Error('Protected business records changed');
const postState = targetState();
const expected = new Map(plans.map(plan => [plan.groupRef, [...plan.members].sort()]));
for (const group of postState.groups as Array<Record<string, unknown>>) {
  const planned = expected.get(String(group.group_ref));
  if (!planned) continue;
  const actual = String(group.members || '').split(',').filter(Boolean).sort();
  if (JSON.stringify(actual) !== JSON.stringify(planned)) {
    throw new Error(`Postcondition failed for ${group.group_ref}: ${JSON.stringify(actual)}`);
  }
}
if ((postState.groups as unknown[]).length !== 2 || (postState.matters as unknown[]).length !== allRefs.length) {
  throw new Error('Postcondition failed: expected groups or matters are missing');
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
  output,
  backup: backup.file,
  clone,
  evidencePath: path.resolve(evidencePath),
  authorization,
  result,
  preStateHash,
  sourceHash,
  protectedTablesUnchanged: true,
  integrity,
  postState,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({
  mode,
  backup: backup.file,
  clone,
  result,
  protectedTablesUnchanged: true,
  integrity,
}));
