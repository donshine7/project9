import { createHash, randomUUID } from 'node:crypto';
import { parseMatterNumber } from './matter-number';
import { transaction, withDatabase, WorkDbError } from './work-db';
import { SOURCE_PRIORITY_VERSION } from './source-policy';

export type GroupReviewEvidence = {
  sheet: string;
  range: string;
  excerpt: string;
};

export type GroupReviewFinding = {
  key: string;
  category: 'unsupported_number_format' | 'partial_membership' | 'missing_matter_numbers';
  title: string;
  organization: string;
  knownMatterRefs: string[];
  rawMatterRefs: string[];
  expectedCount: number | null;
  knownCount: number;
  questions: string[];
  reason: string;
  confidence: number;
  evidence: GroupReviewEvidence[];
};

export type GroupReviewImport = {
  sourceName: string;
  sourceHash: string;
  sourceLastModified: string;
  findings: GroupReviewFinding[];
};

export type GroupReviewAnswer = {
  key: string;
  status: 'resolved' | 'partially_resolved';
  answer: string;
  remainingQuestions?: string[];
};

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();

function requiredText(value: unknown, label: string, max: number) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > max) throw new WorkDbError(`${label}이 비어 있거나 너무 깁니다.`, 400);
  return normalized;
}

export function importGroupReviewFindings(input: GroupReviewImport) {
  const sourceName = requiredText(input.sourceName, '원본 파일명', 500);
  const sourceHash = requiredText(input.sourceHash, '원본 해시', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new WorkDbError('원본 해시는 SHA-256 형식이어야 합니다.', 400);
  const sourceLastModified = requiredText(input.sourceLastModified, '원본 수정시각', 100);
  if (!Array.isArray(input.findings) || !input.findings.length || input.findings.length > 100) throw new WorkDbError('그룹 검토 항목이 필요합니다.', 400);

  const keys = new Set<string>();
  const findings = input.findings.map((raw) => {
    const key = requiredText(raw.key, '검토 키', 120);
    if (keys.has(key)) throw new WorkDbError('검토 키가 중복되었습니다.', 400);
    keys.add(key);
    if (!['unsupported_number_format', 'partial_membership', 'missing_matter_numbers'].includes(raw.category)) throw new WorkDbError(`${key}의 검토 종류가 올바르지 않습니다.`, 400);
    const knownMatterRefs = [...new Set((raw.knownMatterRefs || []).map((ref) => parseMatterNumber(ref).normalized))];
    const rawMatterRefs = [...new Set((raw.rawMatterRefs || []).map((ref) => requiredText(ref, '원문 번호', 100)))];
    const questions = [...new Set((raw.questions || []).map((question) => requiredText(question, '확인 질문', 1000)))];
    if (!questions.length) throw new WorkDbError(`${key}에 확인 질문이 필요합니다.`, 400);
    const expectedCount = raw.expectedCount === null ? null : Number(raw.expectedCount);
    const knownCount = Number(raw.knownCount);
    if ((expectedCount !== null && (!Number.isInteger(expectedCount) || expectedCount < 1)) || !Number.isInteger(knownCount) || knownCount < 0) throw new WorkDbError(`${key}의 사건 수가 올바르지 않습니다.`, 400);
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new WorkDbError(`${key}의 신뢰도가 올바르지 않습니다.`, 400);
    if (!Array.isArray(raw.evidence) || !raw.evidence.length || raw.evidence.length > 20) throw new WorkDbError(`${key}의 Excel 근거가 필요합니다.`, 400);
    const evidence = raw.evidence.map((item) => ({
      sheet: requiredText(item.sheet, '근거 시트', 200),
      range: requiredText(item.range, '근거 범위', 100),
      excerpt: requiredText(item.excerpt, '근거 인용', 4000),
    }));
    return {
      key,
      category: raw.category,
      title: requiredText(raw.title, '검토 제목', 500),
      organization: requiredText(raw.organization, '회사·의뢰인', 300),
      knownMatterRefs,
      rawMatterRefs,
      expectedCount,
      knownCount,
      questions,
      reason: requiredText(raw.reason, '보류 이유', 2000),
      confidence,
      evidence,
    };
  });

  const context = { sourceName, sourceHash, sourceLastModified, findings };
  const contextHash = hash(context);
  const sourceId = `${sourceName}@sha256:${sourceHash}`;

  return withDatabase((db) => transaction(db, () => {
    const duplicate = db.prepare(`
      SELECT r.id
      FROM decision_run r JOIN input_snapshot s ON s.id=r.input_snapshot_id
      WHERE r.operation='group_candidate_review' AND r.status='succeeded' AND s.context_hash=?
      LIMIT 1
    `).get(contextHash) as { id?: string } | undefined;
    if (duplicate?.id) return { runId: duplicate.id, duplicate: true, findingCount: findings.length };

    const timestamp = now();
    const runId = randomUUID();
    const snapshotId = randomUUID();
    const policyId = 'group-candidate-review-v1';
    const policyHash = hash('group-candidate-review-v1:no-auto-create-with-incomplete-members');
    db.prepare(`INSERT OR IGNORE INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,created_at) VALUES (?,'workflow','group-candidate-review-v1',? ,?,'active',?)`)
      .run(policyId, JSON.stringify(['docs/WORK_MANAGEMENT_ARCHITECTURE.md', 'docs/DECISION_FEEDBACK_DESIGN.md']), policyHash, timestamp);
    db.prepare(`INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,'[]','{}',?,?,?,?)`)
      .run(snapshotId, SOURCE_PRIORITY_VERSION, contextHash, JSON.stringify(context), timestamp);

    const result = { runId, sourceName, sourceHash, sourceLastModified, findingCount: findings.length, findings, createdAt: timestamp };
    db.prepare(`INSERT INTO decision_run(id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,input_snapshot_id,status,started_at,completed_at,output_hash,result_json) VALUES (?,'group_candidate_review','deterministic_group_reviewer','group-candidate-review-v1',?,? ,?,'succeeded',?,?,?,?)`)
      .run(runId, policyId, JSON.stringify({ method: 'deterministic', model: null, effort: null, autoApply: false }), snapshotId, timestamp, timestamp, hash(result), JSON.stringify(result));

    for (const finding of findings) {
      const decisionId = randomUUID();
      const valueJson = JSON.stringify(finding);
      db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at) VALUES (?,?,'group_review',?,'group.review','needs_user_input',?,?,?,'high',?,'needs_user_input',?)`)
        .run(decisionId, runId, finding.key, valueJson, valueJson, finding.confidence, finding.reason, timestamp);
      for (const evidence of finding.evidence) {
        db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'excel',?,?,?,?, 'context')`)
          .run(randomUUID(), decisionId, sourceId, JSON.stringify({ sheet: evidence.sheet, range: evidence.range }), evidence.excerpt, hash(evidence.excerpt));
      }
    }
    return { runId, duplicate: false, findingCount: findings.length };
  }));
}

export function recordGroupReviewFeedback(runIdValue: unknown, answersValue: GroupReviewAnswer[]) {
  const runId = requiredText(runIdValue, '검토 실행 ID', 100);
  if (!Array.isArray(answersValue) || !answersValue.length || answersValue.length > 100) throw new WorkDbError('사용자 답변이 필요합니다.', 400);
  const answers = answersValue.map((raw) => ({
    key: requiredText(raw.key, '검토 키', 120),
    status: raw.status,
    answer: requiredText(raw.answer, '사용자 답변', 4000),
    remainingQuestions: [...new Set((raw.remainingQuestions || []).map((question) => requiredText(question, '남은 질문', 1000)))],
  }));
  if (new Set(answers.map((answer) => answer.key)).size !== answers.length) throw new WorkDbError('검토 키가 중복되었습니다.', 400);
  for (const answer of answers) {
    if (!['resolved', 'partially_resolved'].includes(answer.status)) throw new WorkDbError(`${answer.key}의 답변 상태가 올바르지 않습니다.`, 400);
    if (answer.status === 'resolved' && answer.remainingQuestions.length) throw new WorkDbError(`${answer.key}의 완료 답변에는 남은 질문이 없어야 합니다.`, 400);
    if (answer.status === 'partially_resolved' && !answer.remainingQuestions.length) throw new WorkDbError(`${answer.key}의 일부 완료 답변에는 남은 질문이 필요합니다.`, 400);
  }

  return withDatabase((db) => transaction(db, () => {
    const run = db.prepare("SELECT result_json FROM decision_run WHERE id=? AND operation='group_candidate_review' AND status='succeeded'").get(runId) as { result_json?: string } | undefined;
    if (!run?.result_json) throw new WorkDbError('그룹 검토 실행을 찾을 수 없습니다.', 404);
    const findingKeys = new Set((JSON.parse(run.result_json).findings || []).map((finding: GroupReviewFinding) => finding.key));
    let recorded = 0;
    let duplicate = 0;
    for (const answer of answers) {
      if (!findingKeys.has(answer.key)) throw new WorkDbError(`${answer.key}는 해당 검토 실행의 항목이 아닙니다.`, 400);
      const decision = db.prepare("SELECT id,proposed_value_json FROM decision_item WHERE decision_run_id=? AND subject_type='group_review' AND subject_key=?").get(runId, answer.key) as { id: string; proposed_value_json: string } | undefined;
      if (!decision) throw new WorkDbError(`${answer.key}의 판단 기록을 찾을 수 없습니다.`, 404);
      const final = { status: answer.status, answer: answer.answer, remainingQuestions: answer.remainingQuestions };
      const finalJson = JSON.stringify(final);
      const latest = db.prepare('SELECT final_value_json FROM user_feedback WHERE decision_item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(decision.id) as { final_value_json?: string } | undefined;
      if (latest?.final_value_json === finalJson) {
        duplicate += 1;
        continue;
      }
      const correlationId = `${runId}:${answer.key}:user-feedback:${hash(final).slice(0, 16)}`;
      const timestamp = now();
      const eventId = randomUUID();
      const beforeJson = latest?.final_value_json ?? decision.proposed_value_json;
      db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at) VALUES (?,'group_review',?,'group_review.user_feedback',?,?, '장진태','user_input',?,?)`)
        .run(eventId, answer.key, beforeJson, finalJson, correlationId, timestamp);
      const feedbackId = randomUUID();
      db.prepare(`INSERT INTO user_feedback(id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,new_evidence_ids_json,created_at) VALUES (?,?,?,'장진태',?,?,?,?,?,'[]',?)`)
        .run(feedbackId, decision.id, eventId, answer.status === 'resolved' ? 'accept' : 'edit', beforeJson, finalJson, 'new_evidence', answer.answer, timestamp);
      db.prepare(`INSERT INTO decision_comparison(id,user_feedback_id,comparison_type,changed_paths_json,model_error_class,eligible_for_eval,excluded_reason,compared_at) VALUES (?,?, 'different','["group.review"]','unknown',0,'사용자 신규 증거·범위 확정',?)`)
        .run(randomUUID(), feedbackId, timestamp);
      db.prepare('UPDATE decision_item SET review_status=? WHERE id=?').run(answer.status === 'resolved' ? 'accepted' : 'needs_user_input', decision.id);
      recorded += 1;
    }
    return { runId, recorded, duplicate };
  }));
}
