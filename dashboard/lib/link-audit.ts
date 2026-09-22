import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { matterReferenceTokens, parseMatterNumber } from './matter-number';
import { transaction, withDatabase } from './work-db';
import { SOURCE_PRIORITY_VERSION } from './source-policy';

type Row = Record<string, any>;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function withoutUrls(value: string) { return value.replace(/https?:\/\/[^\s<>"']+/gi, match => ' '.repeat(match.length)); }
function excerpt(value: string, token: string, searchable = value) {
  const at = searchable.indexOf(token);
  if (at < 0) return value.slice(0, 500);
  return value.slice(Math.max(0, at - 120), Math.min(value.length, at + token.length + 120));
}
// Read-only projection of references; audit persistence never changes mail links.
export function auditMailLinks() {
  return withDatabase(db => transaction(db, () => {
    const mails = db.prepare('SELECT id,subject,body_text,body_hash FROM mail_item ORDER BY id').all() as Row[];
    const matters = db.prepare('SELECT id,our_ref,row_version,user_confirmed FROM matter WHERE archived_at IS NULL ORDER BY id').all() as Row[];
    const links = db.prepare('SELECT * FROM mail_matter_link ORDER BY mail_id,matter_id').all() as Row[];
    const source = readFileSync(path.resolve(process.env.SSPAT_PROJECT_ROOT || path.resolve(process.cwd(), '..'), 'dashboard/lib/matter-number.ts'), 'utf8');
    const context = { mails, matters, links, parserHash: hash(source), version: 'whole-reference-audit-v2' };
    const fingerprint = hash(context);
    const previous = db.prepare("SELECT r.id,r.result_json FROM decision_run r JOIN input_snapshot s ON s.id=r.input_snapshot_id WHERE r.operation='matter_link_audit' AND s.context_hash=? AND r.status='succeeded'").get(fingerprint);
    if (previous) return { ...JSON.parse(String(previous.result_json)), duplicate: true };
    const findings: Row[] = [];
    for (const mail of mails) {
      const subject = matterReferenceTokens(mail.subject), bodyText = withoutUrls(mail.body_text), body = matterReferenceTokens(bodyText);
      const tokens = [...new Set([...subject, ...body])];
      for (const link of links.filter(l => l.mail_id === mail.id)) {
        const matter = matters.find(m => m.id === link.matter_id);
        const verifiedIndirect = link.match_source === 'user_confirmed_thread';
        if (!matter || (!tokens.includes(matter.our_ref) && !verifiedIndirect)) findings.push({ findingKey: `existing_link_review:${mail.id}:${matter?.our_ref || link.matter_id}`, mailId: mail.id, subject: mail.subject, sourceField: 'subject', evidenceExcerpt: mail.subject, kind: 'existing_link_review', matterRef: matter?.our_ref || link.matter_id, tokens, reason: link.match_source === 'user_input' ? '사용자 확정 연결: 직접 번호 일치 없음. 확정값 유지, 간접 근거 확인 필요.' : '기존 연결에 전체 번호 직접 일치 없음. 부분 일치·인용문·간접 근거 재검토 필요.' });
      }
      for (const token of tokens) {
        try { parseMatterNumber(token); } catch {
          const sourceField = subject.includes(token) ? 'subject' : 'body_text';
          const sourceValue = sourceField === 'subject' ? mail.subject : mail.body_text;
          const searchable = sourceField === 'subject' ? mail.subject : bodyText;
          findings.push({ findingKey: `unknown_pattern:${mail.id}:${token}`, mailId: mail.id, subject: mail.subject, sourceField, evidenceExcerpt: excerpt(sourceValue, token, searchable), kind: 'unknown_pattern', matterRef: token, tokens: [token], reason: '지원하지 않는 형식 또는 괄호 설명. 원문 보존; 당소번호 여부부터 확인.' }); continue;
        }
        const matter = matters.find(m => m.our_ref === token);
        if (!matter || !links.some(l => l.mail_id === mail.id && l.matter_id === matter.id)) {
          const kind = matter ? 'missing_link' : 'unregistered_ref';
          const sourceField = subject.includes(token) ? 'subject' : 'body_text';
          const sourceValue = sourceField === 'subject' ? mail.subject : mail.body_text;
          const searchable = sourceField === 'subject' ? mail.subject : bodyText;
          findings.push({ findingKey: `${kind}:${mail.id}:${token}`, mailId: mail.id, subject: mail.subject, sourceField, evidenceExcerpt: excerpt(sourceValue, token, searchable), kind, matterRef: token, tokens: [token], reason: `${sourceField === 'subject' ? '제목' : '본문(인용 이력 포함)'} 전체 번호 발견. ${matter ? '연결 후보' : '사건 미등록'}이며 실제 사건·별칭 여부 확인 전 생성하지 않음.` });
        }
      }
    }
    const runId = randomUUID(), snapshotId = randomUUID(), timestamp = new Date().toISOString();
    const result = { runId, mailCount: mails.length, linkCount: links.length, findings, createdAt: timestamp };
    db.prepare("INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,?,?,?,?,?,?)").run(snapshotId, JSON.stringify(mails.map(m => m.id)), JSON.stringify(matters), SOURCE_PRIORITY_VERSION, fingerprint, JSON.stringify(context), timestamp);
    db.prepare("INSERT INTO decision_run(id,operation,agent_name,prompt_version,routing_snapshot_json,input_snapshot_id,status,started_at,completed_at,output_hash,result_json) VALUES (?,'matter_link_audit','deterministic','whole-reference-audit-v2',?,?,'succeeded',?,?,?,?)").run(runId, JSON.stringify({ parserHash: context.parserHash, model: null }), snapshotId, timestamp, timestamp, hash(result), JSON.stringify(result));
    for (const finding of findings) {
      const itemId = randomUUID();
      db.prepare("INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at) VALUES (?,?,'mail',?,'link.audit','review',?,?,1,'high',?,'not_reviewed',?)").run(itemId, runId, finding.findingKey, JSON.stringify(finding), JSON.stringify(finding), finding.reason, timestamp);
      db.prepare("INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'mail',?,?,?,?,'context')").run(randomUUID(), itemId, finding.mailId, JSON.stringify({ field: finding.sourceField }), finding.evidenceExcerpt, createHash('sha256').update(finding.evidenceExcerpt).digest('hex'));
    }
    return { ...result, duplicate: false };
  }));
}
