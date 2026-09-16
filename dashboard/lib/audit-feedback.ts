import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction, withDatabase, WorkDbError } from './work-db';
import { verifiedReferenceNotes } from './reference-review';

type Row = Record<string, any>;
const AUDIT_FIELDS = new Set(['link.audit', 'parties.coverage']);
const FEEDBACK_STATUSES = new Set(['resolved', 'needs_follow_up', 'dismissed']);
const stamp = () => new Date().toISOString();

function requiredText(value: unknown, label: string, max = 2000) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new WorkDbError(`${label}을(를) 입력하세요.`, 400, 'AUDIT_FEEDBACK_VALIDATION');
  if (normalized.length > max) throw new WorkDbError(`${label}은(는) ${max}자 이하여야 합니다.`, 400, 'AUDIT_FEEDBACK_VALIDATION');
  return normalized;
}

export function decorateAuditFindings(db: DatabaseSync, runId: string, findings: Row[]) {
  const decisions = db.prepare(`SELECT id,subject_key,field_path,proposed_value_json,review_status FROM decision_item WHERE decision_run_id=? AND field_path IN ('link.audit','parties.coverage')`).all(runId) as Row[];
  const remaining = [...decisions];
  return findings.map(finding => {
    const serialized = JSON.stringify(finding);
    const indexByStableKey = remaining.findIndex(item => {
      const stableKey = item.field_path === 'link.audit' ? finding.findingKey : finding.matterRef;
      return Boolean(stableKey) && item.subject_key === stableKey;
    });
    const index = indexByStableKey >= 0 ? indexByStableKey : remaining.findIndex(item => item.proposed_value_json === serialized);
    const decision = index >= 0 ? remaining.splice(index, 1)[0] : undefined;
    const directFeedback = decision ? db.prepare('SELECT decision_item_id,final_value_json,created_at FROM user_feedback WHERE decision_item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(decision.id) as Row | undefined : undefined;
    const inheritedFeedback = !directFeedback && decision
      ? db.prepare(`SELECT f.decision_item_id,f.final_value_json,f.created_at
          FROM user_feedback f
          JOIN decision_item d ON d.id=f.decision_item_id
          WHERE d.field_path=? AND d.subject_key=? AND d.id<>?
          ORDER BY f.created_at DESC,f.rowid DESC
          LIMIT 1`).get(decision.field_path, decision.subject_key, decision.id) as Row | undefined
      : undefined;
    const feedback = directFeedback || inheritedFeedback;
    return {
      ...finding,
      decisionId: decision?.id || null,
      reviewStatus: decision?.review_status || 'not_reviewed',
      userAnswer: feedback ? JSON.parse(feedback.final_value_json) : null,
      answeredAt: feedback?.created_at || null,
      inheritedFeedback: Boolean(inheritedFeedback),
      feedbackSourceDecisionId: feedback?.decision_item_id || null,
      verifiedNotes: decision?.field_path === 'link.audit' ? verifiedReferenceNotes(db, finding.mailId, finding.matterRef) : [],
    };
  });
}

export function recordAuditFeedback(decisionId: string, input: { status?: unknown; answer?: unknown }) {
  const status = String(input?.status ?? '');
  if (!FEEDBACK_STATUSES.has(status)) throw new WorkDbError('검토 결과 값이 올바르지 않습니다.', 400, 'AUDIT_FEEDBACK_VALIDATION');
  const answer = requiredText(input?.answer, '검토 답변');
  return withDatabase(db => transaction(db, () => {
    const decision = db.prepare(`SELECT d.*,r.operation FROM decision_item d JOIN decision_run r ON r.id=d.decision_run_id WHERE d.id=?`).get(decisionId) as Row | undefined;
    if (!decision || !AUDIT_FIELDS.has(decision.field_path) || !['matter_link_audit', 'relationship_coverage_audit'].includes(decision.operation)) {
      throw new WorkDbError('검토할 감사 항목을 찾을 수 없습니다.', 404, 'AUDIT_FEEDBACK_NOT_FOUND');
    }
    const finalValue = { status, answer };
    const latest = db.prepare('SELECT final_value_json FROM user_feedback WHERE decision_item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(decisionId) as Row | undefined;
    if (latest?.final_value_json === JSON.stringify(finalValue)) return { decisionId, duplicate: true, reviewStatus: decision.review_status };

    const eventId = randomUUID(), feedbackId = randomUUID(), timestamp = stamp();
    const entityType = decision.field_path === 'parties.coverage' ? 'relationship_audit' : 'matter_link_audit';
    const before = latest ? JSON.parse(latest.final_value_json) : JSON.parse(decision.proposed_value_json);
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,?,?,?,'장진태','user_input',?,?)`)
      .run(eventId, entityType, decisionId, 'audit.user_feedback', JSON.stringify(before), JSON.stringify(finalValue), decisionId, timestamp);
    db.prepare(`INSERT INTO user_feedback(id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,new_evidence_ids_json,created_at) VALUES (?,?,?,'장진태','edit',?,?, 'new_evidence',?,'[]',?)`)
      .run(feedbackId, decisionId, eventId, JSON.stringify(before), JSON.stringify(finalValue), answer, timestamp);
    db.prepare(`INSERT INTO decision_comparison(id,user_feedback_id,comparison_type,changed_paths_json,model_error_class,eligible_for_eval,excluded_reason,compared_at) VALUES (?,?,'different',?,'unknown',0,'사용자 신규 증거·검토 판단',?)`)
      .run(randomUUID(), feedbackId, JSON.stringify([decision.field_path]), timestamp);
    const reviewStatus = status === 'resolved' ? 'accepted' : status === 'dismissed' ? 'rejected' : 'needs_user_input';
    db.prepare('UPDATE decision_item SET review_status=? WHERE id=?').run(reviewStatus, decisionId);
    return { decisionId, eventId, reviewStatus, duplicate: false };
  }));
}
