import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { hasExactMatterReference, parseMatterNumber } from './matter-number';
import { ACTION_PRIORITIES, BUSINESS_TYPES, TEAM_MEMBERS, transaction, withDatabase, WorkDbError } from './work-db';
import { decorateAuditFindings } from './audit-feedback';

type Row = Record<string, any>;
type Evidence = { mailId: string; field: string; quote: string };
type Field = { value: unknown; confidence: number; rationale: string; evidence: Evidence[] };
type Candidate = { key: string; kind: string; entityType: string; entityId: string; fields: Record<string, Field> };
type Result = { schemaVersion: number; runId: string; coverage: { mailId: string; outcome: string; reason: string }[]; candidates: Candidate[] };
const operations: Record<string, string> = { mail_fact_extraction: 'fact', matter_linking: 'link', action_judgement: 'action', high_risk_verification: 'risk', wiki_revision: 'wiki' };
const tables: Record<string, string> = { matter: 'matter', organization: 'organization', person: 'person', group: 'matter_group', mail: 'mail_item', candidate: 'analysis_candidate' };
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
function check(condition: unknown, message: string, status = 400): asserts condition { if (!condition) throw new WorkDbError(message, status, 'ANALYSIS_VALIDATION'); }
function text(value: unknown, max = 4000): asserts value is string { check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, '비어 있거나 너무 긴 문자열입니다.'); }
function row(db: DatabaseSync, sql: string, ...params: string[]) { return db.prepare(sql).get(...params) as Row | undefined; }

// The repository uses a deliberately small TOML subset. Reject missing/ambiguous keys.
export function analysisPolicy() {
  const root = process.env.SSPAT_PROJECT_ROOT || path.resolve(process.cwd(), '..');
  const routing = readFileSync(path.join(root, 'config/llm-routing.toml'), 'utf8');
  const contract = readFileSync(path.join(root, 'config/analysis-contract.md'), 'utf8');
  const rules = readFileSync(path.join(root, 'docs/WORK_MANAGEMENT_ARCHITECTURE.md'), 'utf8');
  const routes: Record<string, Row> = {};
  for (const operation of Object.keys(operations)) {
    const section = routing.split(`[operations.${operation}]`);
    check(section.length === 2, `라우팅 섹션 오류: ${operation}`, 500);
    const block = section[1].split(/\r?\n\[/)[0];
    const get = (source: string, key: string) => {
      const matches = [...source.matchAll(new RegExp(`^${key} = "([^"\\r\\n]+)"`, 'gm'))];
      check(matches.length === 1, `라우팅 키 오류: ${key}`, 500);
      return matches[0][1];
    };
    const configFile = get(block, 'config_file');
    check(/^config\/agents\/[a-z-]+\.toml$/.test(configFile), '역할 경로 오류', 500);
    const role = readFileSync(path.join(root, configFile), 'utf8');
    const model = get(block, 'model'), effort = get(block, 'reasoning_effort'), agent = get(block, 'agent');
    check(model === get(role, 'model') && effort === get(role, 'model_reasoning_effort') && agent === get(role, 'name'), '라우팅과 역할 설정이 다릅니다.', 500);
    routes[operation] = { model, effort, agent, configFile, role, promptVersion: `analysis-v1-${hash(role + contract).slice(0, 12)}` };
  }
  return { routes, contract, routing, policyHash: hash({ routing, rules, contract, routes }) };
}

function mailHash(mail: Row) {
  return hash([mail.subject, mail.body_text, mail.sender_name, mail.sender_email, mail.recipients_json, mail.mail_at, mail.direction, mail.conversation_id, mail.folder_path]);
}
function sourceMail(db: DatabaseSync, id: string) { const mail = row(db, 'SELECT * FROM mail_item WHERE id=?', id); check(mail, '원본 메일을 찾을 수 없습니다.', 404); return mail; }
function entity(db: DatabaseSync, type: string, id: string) {
  check(Object.hasOwn(tables, type), '대상 유형 오류');
  const found = row(db, `SELECT * FROM ${tables[type]} WHERE id=?`, id);
  check(found && !found.archived_at, '분석 대상이 없거나 보관되었습니다.', 409);
  return found;
}
export function analysisMailIndex() {
  return withDatabase(db => db.prepare('SELECT id,subject,mail_at,direction,conversation_id FROM mail_item ORDER BY mail_at DESC').all());
}

export function prepareAnalysis(operation: string, mailIds: string[]) {
  check(Object.hasOwn(operations, operation), '알 수 없는 분석 동작');
  check(operation !== 'wiki_revision', 'Wiki 게시·개정 실행은 4단계에서 연결합니다. 현재는 분석 근거를 먼저 확정하세요.');
  check(Array.isArray(mailIds) && mailIds.length > 0 && mailIds.length <= 200 && new Set(mailIds).size === mailIds.length, '분석 대상은 중복 없는 1~200개 메일이어야 합니다.');
  const policy = analysisPolicy();
  return withDatabase(db => transaction(db, () => {
    const mails = mailIds.map(id => sourceMail(db, id));
    const entities: Record<string, Row> = {};
    for (const [type, table] of Object.entries(tables)) {
      if (type === 'mail' || type === 'candidate') continue;
      for (const item of db.prepare(`SELECT * FROM ${table} WHERE archived_at IS NULL`).all() as Row[]) entities[`${type}:${item.id}`] = item;
    }
    const works = db.prepare('SELECT * FROM work_item WHERE archived_at IS NULL').all();
    const actions = db.prepare('SELECT * FROM action_item WHERE archived_at IS NULL').all();
    const assignments = db.prepare('SELECT * FROM assignment WHERE archived_at IS NULL').all();
    const links = (db.prepare('SELECT * FROM mail_matter_link').all() as Row[]).filter(x => mailIds.includes(x.mail_id));
    const candidates = (db.prepare('SELECT * FROM analysis_candidate').all() as Row[]).filter(x => {
      const c = JSON.parse(x.payload_json) as Candidate;
      return Object.values(c.fields).some(f => f.evidence.some(e => mailIds.includes(e.mailId)));
    });
    const events = candidates.filter(c => c.applied_event_id).map(c => row(db, 'SELECT * FROM event WHERE id=?', c.applied_event_id));
    const mailRegistry = db.prepare('SELECT id FROM mail_item ORDER BY id').all();
    const context = { mails: mails.map(m => ({ id: m.id, hash: mailHash(m) })), mailRegistry, entities, works, actions, assignments, links, candidates, events };
    const snapshotId = randomUUID(), runId = randomUUID(), revisionId = `analysis-${policy.policyHash}`;
    const route = policy.routes[operation];
    db.prepare(`INSERT OR IGNORE INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,created_at) VALUES (?,'workflow',?,? ,?,'active',?)`).run(revisionId, policy.policyHash, JSON.stringify(['config/llm-routing.toml', route.configFile, 'config/analysis-contract.md', 'docs/WORK_MANAGEMENT_ARCHITECTURE.md']), policy.policyHash, stamp());
    db.prepare(`INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,?,?,'user-registration-excel-mail-v1',?,?,?)`).run(snapshotId, JSON.stringify(context.mails), JSON.stringify(entities), hash(context), JSON.stringify(context), stamp());
    db.prepare(`INSERT INTO decision_run(id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,input_snapshot_id,status,started_at) VALUES (?,?,?,?,?,?,?,'prepared',?)`).run(runId, operation, route.agent, route.promptVersion, revisionId, JSON.stringify({ ...route, contract: policy.contract, policyHash: policy.policyHash }), snapshotId, stamp());
    return { runId, operation, route: { agent: route.agent, model: route.model, effort: route.effort }, mailCount: mails.length };
  }));
}

function runContext(db: DatabaseSync, runId: string) {
  const run = row(db, 'SELECT * FROM decision_run WHERE id=?', runId); check(run, '실행을 찾을 수 없습니다.', 404);
  const snapshot = row(db, 'SELECT * FROM input_snapshot WHERE id=?', run.input_snapshot_id)!;
  const context = JSON.parse(snapshot.context_json);
  check(hash(context) === snapshot.context_hash, '입력 스냅샷 해시 오류', 409);
  const mails = context.mails.map((ref: Row) => { const mail = sourceMail(db, ref.id); check(mailHash(mail) === ref.hash, '원본 메일이 변경되었습니다. 재분석하세요.', 409); return mail; });
  return { run, context, mails, route: JSON.parse(run.routing_snapshot_json) };
}
export function analysisPacket(runId: string) {
  return withDatabase(db => { const { run, context, mails, route } = runContext(db, runId); return { schemaVersion: 1, runId, operation: run.operation, route, context, mails }; });
}
export function bindAnalysis(runId: string, execution: { agentId: string; model: string; effort: string }) {
  text(execution.agentId, 200);
  return withDatabase(db => transaction(db, () => {
    const { run, route } = runContext(db, runId);
    check(run.status === 'prepared', '이미 시작된 실행입니다.', 409);
    check(execution.model === route.model && execution.effort === route.effort, '실제 디스패치와 모델 라우팅이 다릅니다.', 409);
    db.prepare(`UPDATE decision_run SET model=?,reasoning_effort=?,execution_ref=?,status='started',started_at=? WHERE id=?`).run(execution.model, execution.effort, execution.agentId, stamp(), runId);
    return { runId, status: 'started' };
  }));
}
export function failAnalysis(runId: string, code: string) {
  text(code, 100);
  return withDatabase(db => { const changed = db.prepare(`UPDATE decision_run SET status='failed',error_code=?,completed_at=? WHERE id=? AND status IN ('prepared','started')`).run(code, stamp(), runId); check(changed.changes === 1, '실행 상태 충돌', 409); return { runId, status: 'failed' }; });
}

function values(c: Candidate): Row { return Object.fromEntries(Object.entries(c.fields).map(([key, field]) => [key, field.value])); }
function validateValues(c: Candidate) {
  const v = values(c), keys = Object.keys(v).sort().join(',');
  if (c.kind === 'fact' || c.kind === 'wiki') { check(keys === 'summary', '요약 필드 오류'); text(v.summary); }
  else if (c.kind === 'link') {
    check(keys === 'matterRef' || keys === 'matterRef,registrationBasis' || keys === 'businessType,email,matterRef,name,partyType,role', '연결 필드 오류');
    check(parseMatterNumber(v.matterRef).normalized === v.matterRef, '전체 관리번호를 정규화하세요.');
    if (keys === 'matterRef,registrationBasis') check(['registration_mail', 'active_matter_mail'].includes(v.registrationBasis), '신규 사건 근거 유형이 올바르지 않습니다.');
    else if (keys !== 'matterRef') {
      check(['organization', 'person'].includes(v.partyType), '회사·자연인 유형 오류');
      text(v.name, 200); text(v.role, 100);
      check(v.name === v.name.trim() && v.role === v.role.trim(), '이름·역할의 공백을 정리하세요.');
      check(v.partyType === 'organization' ? BUSINESS_TYPES.includes(v.businessType) && v.email === null : v.businessType === null && typeof v.email === 'string' && v.email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) && v.email === v.email.toLowerCase(), '자연인은 명시된 이메일과 회사 구분 null, 회사는 개인사업자·법인·미정 중 하나와 email null이 필요합니다.');
    }
  }
  else if (c.kind === 'risk') { check(keys === 'verdict' && ['confirmed', 'rejected', 'needs_review'].includes(v.verdict), '검증 결과 오류'); }
  else if (c.kind === 'action') {
    check(typeof v.required === 'boolean', 'Action 필요 여부 오류');
    if (!v.required) check(keys === 'required', '불필요 Action은 필요 여부만 기록하세요.');
    else {
      check(keys === 'assignee,dueDate,priority,required,title', 'Action 필드 오류'); text(v.title, 500);
      check(TEAM_MEMBERS.includes(v.assignee) && ACTION_PRIORITIES.includes(v.priority), 'Action 담당자·중요도 오류');
      check(v.dueDate === null || (typeof v.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.dueDate) && Number.isFinite(Date.parse(v.dueDate)) && new Date(v.dueDate).toISOString().slice(0, 10) === v.dueDate), '실재하는 ISO 날짜 또는 null을 입력하세요.');
    }
  } else check(false, '후보 종류 오류');
}
function riskLevel(c: Candidate) {
  const v = values(c);
  // Conservative, deterministic floor: dates/financial/legal claims always need independent review.
  return c.kind === 'link' || v.dueDate || /기일|기한|납부|입금|미수|청구|비용|출원|제출|등록|거절|OA|마감|송금|payment|deadline|filing/i.test(JSON.stringify(c.fields)) ? 'high' : 'low';
}

export function ingestAnalysis(result: Result) {
  check(result?.schemaVersion === 1 && Array.isArray(result.candidates) && result.candidates.length <= 1000 && Array.isArray(result.coverage), '분석 결과 형식 오류');
  return withDatabase(db => transaction(db, () => {
    const { run, context, mails } = runContext(db, result.runId);
    check(run.operation !== 'wiki_revision', 'Wiki는 문장별 이벤트 계약(wiki-ingest)으로 저장하세요.');
    const outputHash = hash(result);
    if (run.status === 'succeeded') { check(run.output_hash === outputHash, '같은 실행의 결과를 덮어쓸 수 없습니다.', 409); return { runId: result.runId, count: result.candidates.length, duplicate: true }; }
    check(run.status === 'started' && run.execution_ref && run.model, '실제 모델 디스패치를 먼저 기록하세요.', 409);
    const mailMap = new Map<string, Row>(mails.map((m: Row) => [m.id, m]));
    check(result.coverage.length === mails.length && new Set(result.coverage.map(c => c.mailId)).size === mails.length, '모든 입력 메일의 처리 결과를 한 번씩 기록해야 합니다.');
    for (const coverage of result.coverage) { check(mailMap.has(coverage.mailId) && ['candidate', 'no_change', 'needs_review'].includes(coverage.outcome), '메일 처리 범위 오류'); text(coverage.reason, 1000); }
    const keys = new Set<string>(), citedMails = new Set<string>();
    for (const candidate of result.candidates) {
      text(candidate.key, 120); check(!keys.has(candidate.key), '후보 키 중복'); keys.add(candidate.key);
      check(candidate.kind === operations[run.operation], '역할에 허용되지 않은 후보 종류');
      check(candidate.fields && typeof candidate.fields === 'object' && !Array.isArray(candidate.fields), '필드 계약 오류');
      validateValues(candidate);
      if (candidate.kind === 'fact' || candidate.kind === 'link') check(candidate.entityType === 'mail' && mailMap.has(candidate.entityId), '메일 대상 오류');
      if (candidate.kind === 'action') check(candidate.entityType === 'matter' && context.entities[`matter:${candidate.entityId}`], '사건 대상 오류');
      if (candidate.kind === 'wiki') { check(['matter', 'organization', 'person', 'group'].includes(candidate.entityType) && context.entities[`${candidate.entityType}:${candidate.entityId}`], 'Wiki 대상 오류'); check(context.events.length > 0, 'Wiki에는 확정 이벤트가 필요합니다.'); }
      if (candidate.kind === 'risk') {
        const prior = context.candidates.find((c: Row) => c.id === candidate.entityId && c.kind !== 'risk');
        check(candidate.entityType === 'candidate' && prior, '검증 대상은 입력에 있는 기존 후보여야 합니다.');
        const priorRun = row(db, 'SELECT execution_ref FROM decision_run WHERE id=?', prior.run_id);
        check(priorRun?.execution_ref && priorRun.execution_ref !== run.execution_ref, '동일 실행 작업은 자기 결론을 독립 검증할 수 없습니다.');
      }
      entity(db, candidate.entityType, candidate.entityId);
      if (candidate.kind === 'link') {
        const v = values(candidate);
        const exists = Object.values(context.entities).some((m: any) => m.our_ref === v.matterRef);
        if (v.registrationBasis) {
          check(!exists && !row(db, 'SELECT id FROM matter WHERE our_ref=?', v.matterRef), '이미 존재하는 사건은 신규 등록할 수 없습니다.');
          const source = mailMap.get(candidate.entityId)!;
          check(hasExactMatterReference(source.subject, v.matterRef) || hasExactMatterReference(source.body_text, v.matterRef), '신규 등록에는 전체 사건번호 일치가 필요합니다.');
          check(candidate.fields.matterRef.evidence.some(e => hasExactMatterReference(e.quote, v.matterRef)), '관리번호 자체의 인용 근거가 필요합니다.');
        } else check(exists, '입력에 없는 사건 연결입니다.');
      }
      if (candidate.kind === 'link' && values(candidate).partyType) {
        const source = mailMap.get(candidate.entityId)!;
        check(hasExactMatterReference(source.subject, values(candidate).matterRef) || hasExactMatterReference(source.body_text, values(candidate).matterRef), '관계 후보에는 전체 사건번호 일치가 필요합니다.');
      }
      for (const field of Object.values(candidate.fields)) {
        check(Number.isFinite(field.confidence) && field.confidence >= 0 && field.confidence <= 1, '신뢰도 오류'); text(field.rationale, 2000);
        check(Array.isArray(field.evidence) && field.evidence.length > 0 && field.evidence.length <= 30, '필드별 근거가 필요합니다.');
        for (const e of field.evidence) {
          const mail = mailMap.get(e.mailId); check(mail && ['subject', 'body_text', 'sender_name', 'sender_email', 'recipients_json'].includes(e.field), '근거 위치 오류'); text(e.quote, 4000);
          check(typeof mail[e.field] === 'string' && mail[e.field].includes(e.quote), '인용문이 원본과 일치하지 않습니다.'); citedMails.add(e.mailId);
          if (candidate.kind === 'fact' || candidate.kind === 'link') check(e.mailId === candidate.entityId, '다른 메일의 사실을 섞을 수 없습니다.');
          if (candidate.kind === 'action') check(context.links.some((l: Row) => l.mail_id === e.mailId && l.matter_id === candidate.entityId), 'Action 근거 메일과 사건의 연결을 먼저 확정하세요.');
        }
      }
      const id = randomUUID(), risk = riskLevel(candidate);
      db.prepare(`INSERT INTO analysis_candidate(id,run_id,candidate_key,kind,entity_type,entity_id,payload_json,risk_level,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, result.runId, candidate.key, candidate.kind, candidate.entityType, candidate.entityId, JSON.stringify(candidate), risk, stamp());
      for (const [key, field] of Object.entries(candidate.fields)) {
        const itemId = randomUUID();
        db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,created_at) VALUES (?,?,?,?,?,'create',?,?,?,?,?,?)`).run(itemId, result.runId, candidate.entityType, id, `${candidate.kind}.${key}`, JSON.stringify(field.value), JSON.stringify(field.value), field.confidence, risk, field.rationale, stamp());
        for (const e of field.evidence) db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'mail',?,?,?,?,'support')`).run(randomUUID(), itemId, e.mailId, JSON.stringify({ field: e.field }), e.quote, hash(e.quote));
      }
    }
    for (const c of result.coverage) {
      if (c.outcome === 'candidate') check(citedMails.has(c.mailId), '후보로 처리한 메일에 근거 후보가 없습니다.');
      const decisionId = randomUUID();
      db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at) VALUES (?,?,'mail',?,'coverage.outcome','no_change',?,?,0,'medium',?,'not_reviewed',?)`).run(decisionId, result.runId, c.mailId, JSON.stringify(c.outcome), JSON.stringify(c.outcome), c.reason, stamp());
      const excerpt = mailMap.get(c.mailId)!.subject;
      db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'mail',?,'{"field":"subject"}',?,?,'context')`).run(randomUUID(), decisionId, c.mailId, excerpt, hash(excerpt));
    }
    db.prepare(`UPDATE decision_run SET status='succeeded',completed_at=?,output_hash=?,result_json=? WHERE id=?`).run(stamp(), outputHash, JSON.stringify(result), result.runId);
    return { runId: result.runId, count: result.candidates.length, duplicate: false };
  }));
}

export function analysisStatus() {
  return withDatabase(db => ({
    linkAudit: (() => { const r = row(db, "SELECT id,result_json FROM decision_run WHERE operation='matter_link_audit' AND status='succeeded' ORDER BY completed_at DESC LIMIT 1"); if (!r) return null; const result = JSON.parse(r.result_json); return { ...result, findings: decorateAuditFindings(db, r.id, result.findings) }; })(),
    relationshipAudit: (() => { const r = row(db, "SELECT id,result_json FROM decision_run WHERE operation='relationship_coverage_audit' AND status='succeeded' ORDER BY completed_at DESC LIMIT 1"); if (!r) return null; const result = JSON.parse(r.result_json); return { ...result, findings: decorateAuditFindings(db, r.id, result.findings) }; })(),
    groupReview: (() => {
      const r = row(db, "SELECT id,result_json FROM decision_run WHERE operation='group_candidate_review' AND status='succeeded' ORDER BY completed_at DESC LIMIT 1");
      if (!r) return null;
      const result = JSON.parse(r.result_json);
      result.findings = result.findings.map((finding: Row) => {
        const decision = row(db, "SELECT id,review_status FROM decision_item WHERE decision_run_id=? AND subject_type='group_review' AND subject_key=?", r.id, finding.key);
        const feedback = decision ? row(db, 'SELECT final_value_json,note,created_at FROM user_feedback WHERE decision_item_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', decision.id) : null;
        return { ...finding, reviewStatus: decision?.review_status || 'needs_user_input', userAnswer: feedback ? JSON.parse(feedback.final_value_json) : null, answeredAt: feedback?.created_at || null };
      });
      return result;
    })(),
    runs: (db.prepare('SELECT id,operation,agent_name,model,reasoning_effort,prompt_version,status,execution_ref,started_at,completed_at,error_code,result_json,retry_of FROM decision_run ORDER BY started_at DESC LIMIT 100').all() as Row[]).map((r): Row => ({ ...r, result_json: undefined, coverage: r.result_json ? JSON.parse(r.result_json).coverage || [] : [] })),
    candidates: (db.prepare('SELECT c.*,r.model,r.reasoning_effort,r.prompt_version FROM analysis_candidate c JOIN decision_run r ON r.id=c.run_id ORDER BY c.created_at DESC LIMIT 1000').all() as Row[]).map((c): Row => {
      const payload = JSON.parse(c.payload_json), proposed = values(payload);
      let existingPartyOptions: Row[] = [];
      if (c.kind === 'link' && proposed.partyType && proposed.matterRef) {
        const matter = row(db, 'SELECT id FROM matter WHERE our_ref=? AND archived_at IS NULL', proposed.matterRef);
        if (matter) existingPartyOptions = [
          ...(db.prepare(`SELECT o.id,'organization' partyType,o.name,o.business_type businessType,NULL email,mp.role FROM organization o JOIN matter_party mp ON mp.party_id=o.id AND mp.party_type='organization' WHERE mp.matter_id=? AND o.archived_at IS NULL`).all(matter.id) as Row[]),
          ...(db.prepare(`SELECT p.id,'person' partyType,p.name,NULL businessType,p.email,mp.role FROM person p JOIN matter_party mp ON mp.party_id=p.id AND mp.party_type='person' WHERE mp.matter_id=? AND p.archived_at IS NULL`).all(matter.id) as Row[]),
        ];
      }
      return { ...c, payload, payload_json: undefined, entityLabel: entityLabel(db, c.entity_type, c.entity_id), decisions: db.prepare('SELECT * FROM decision_item WHERE subject_key=?').all(c.id), verifications: (db.prepare(`SELECT payload_json FROM analysis_candidate WHERE kind='risk' AND entity_id=?`).all(c.id) as Row[]).map(r => JSON.parse(r.payload_json).fields.verdict), existingPartyOptions };
    }),
    knowledge: db.prepare('SELECT * FROM knowledge_entry ORDER BY entry_date DESC LIMIT 200').all(),
    mailCount: (row(db, 'SELECT COUNT(*) AS n FROM mail_item')!).n,
  }));
}
function entityLabel(db: DatabaseSync, type: string, id: string) { const table = tables[type]; if (!table) return id; const e = row(db, `SELECT * FROM ${table} WHERE id=?`, id); return e?.our_ref || e?.name || e?.group_ref || e?.subject || e?.candidate_key || id; }

// Trusted main-task bridge, intentionally not exposed as a browser mutation.
// Registration is an email-derived observation, not a user-confirmed fact.
export function applyVerifiedRegistration(id: string, authorization: string) {
  text(authorization, 1000);
  return withDatabase(db => transaction(db, () => {
    const original = entity(db, 'candidate', id), c = JSON.parse(original.payload_json) as Candidate;
    validateValues(c);
    const v = values(c);
    check(c.kind === 'link' && ['registration_mail', 'active_matter_mail'].includes(v.registrationBasis), '신규 사건 후보가 아닙니다.');
    if (original.review_status === 'accepted' && original.applied_event_id) {
      const applied = row(db, "SELECT * FROM event WHERE id=? AND event_type IN ('matter.registration_verified','matter.existence_verified') AND correlation_id=?", original.applied_event_id, id);
      check(applied, '등록 이력 충돌', 409);
      return { matterId: applied.entity_id, matterRef: v.matterRef, eventId: applied.id, duplicate: true };
    }
    check(original.review_status === 'pending', '이미 검토된 후보입니다.', 409);
    const { run, context, mails } = runContext(db, original.run_id);
    check(run.status === 'succeeded' && run.execution_ref, '완료된 분석 실행이 필요합니다.', 409);
    check(JSON.stringify(context.mailRegistry) === JSON.stringify(db.prepare('SELECT id FROM mail_item ORDER BY id').all()), '새 메일이 들어왔습니다. 재분석하세요.', 409);
    check(!row(db, 'SELECT id FROM matter WHERE our_ref=?', v.matterRef), '이미 존재하는 사건은 덮어쓰지 않습니다.', 409);
    const mail = mails.find((m: Row) => m.id === c.entityId);
    check(mail && (hasExactMatterReference(mail.subject, v.matterRef) || hasExactMatterReference(mail.body_text, v.matterRef)), '전체 번호 근거가 없습니다.');
    const verifiers = db.prepare("SELECT * FROM analysis_candidate WHERE kind='risk' AND entity_id=?").all(id) as Row[];
    check(verifiers.length > 0, '독립 고위험 검증이 필요합니다.', 409);
    for (const verifier of verifiers) {
      check(values(JSON.parse(verifier.payload_json)).verdict === 'confirmed', '반려·보류 검증은 반영할 수 없습니다.', 409);
      const verified = runContext(db, verifier.run_id);
      check(verified.run.status === 'succeeded' && verified.run.execution_ref !== run.execution_ref && verified.run.execution_ref, '독립 검증 실행 오류', 409);
      check(verified.context.candidates.some((prior: Row) => prior.id === id && prior.payload_json === original.payload_json), '검증한 후보가 변경되었습니다.', 409);
    }
    const parsed = parseMatterNumber(v.matterRef), matterId = randomUUID(), eventId = randomUUID(), at = stamp();
    const confidence = Math.min(...Object.values(c.fields).map(f => f.confidence));
    const sourceType = v.registrationBasis === 'registration_mail' ? 'registration_mail' : 'mail_inference';
    const eventType = v.registrationBasis === 'registration_mail' ? 'matter.registration_verified' : 'matter.existence_verified';
    // No work/status/date, assignment, party, alias or group is created here.
    db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,parent_ref,relation_type,suffixes_json,source_type,source_id,confidence,user_confirmed,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,0,?,?)`)
      .run(matterId, parsed.normalized, parsed.office, parsed.kind, parsed.countryCode, parsed.baseRef, JSON.stringify(parsed.suffixes), sourceType, c.entityId, confidence, at, at);
    db.prepare(`INSERT INTO mail_matter_link(mail_id,matter_id,match_source,confidence,created_at) VALUES (?,?,?,?,?)`).run(c.entityId, matterId, sourceType, confidence, at);
    const after = { matterRef: v.matterRef, registrationBasis: v.registrationBasis, candidateId: id, sourceMailId: c.entityId, authorization, verificationIds: verifiers.map(r => r.id), userConfirmed: false };
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,'matter',?,?,?,?,?,?,?)`).run(eventId, matterId, eventType, JSON.stringify(after), 'Codex', sourceType, id, at);
    const fields = { our_ref: parsed.normalized, office: parsed.office, matter_kind: parsed.kind, country_code: parsed.countryCode };
    for (const [field, value] of Object.entries(fields)) db.prepare(`INSERT INTO source_observation(id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,observed_at,confidence,user_confirmed) VALUES (?,'matter',?,?,?,?,?,?,?,0)`).run(randomUUID(), matterId, field, JSON.stringify(value), sourceType, c.entityId, mail.mail_at, confidence);
    db.prepare("UPDATE analysis_candidate SET review_status='accepted',row_version=row_version+1,applied_event_id=? WHERE id=?").run(eventId, id);
    // Do not manufacture user_feedback or a successful learning example.
    db.prepare("UPDATE decision_item SET review_status='accepted' WHERE subject_key=?").run(id);
    return { matterId, matterRef: v.matterRef, eventId, duplicate: false };
  }));
}

export function reviewCandidate(id: string, input: { action: string; expectedVersion: number; values?: Row; reason?: string; existingPartyId?: string | null }) {
  check(['accept', 'edit', 'reject', 'confirm_relationship'].includes(input.action), '검토 동작 오류');
  if (input.reason !== undefined && input.reason !== '') text(input.reason, 1000);
  return withDatabase(db => transaction(db, () => {
    const original = entity(db, 'candidate', id), c = JSON.parse(original.payload_json) as Candidate;
    check(!values(c).registrationBasis || input.action === 'reject', '신규 사건은 주 작업의 검증된 등록 절차로 반영하세요.');
    const directRelationshipFeedback = input.action === 'confirm_relationship';
    if (directRelationshipFeedback) {
      check(c.kind === 'link' && Boolean(values(c).partyType), '회사·자연인 관계 후보만 사용자 확인으로 반영할 수 있습니다.');
      text(input.reason, 1000);
    }
    check(original.review_status === 'pending' && original.row_version === input.expectedVersion, '이미 검토되었거나 변경되었습니다. 새로고침하세요.', 409);
    check(c.kind !== 'risk' && c.kind !== 'wiki', '검증 결과는 근거이며 Wiki 게시는 4단계 대상입니다.');
    const { context } = runContext(db, original.run_id);
    let v = input.action === 'edit' || directRelationshipFeedback ? input.values : values(c); check(v && typeof v === 'object', '수정값 필요');
    const edited: Candidate = { ...c, fields: Object.fromEntries(Object.entries(v).map(([key, value]) => [key, { ...c.fields[key], value }])) };
    validateValues(edited);
    const target = entity(db, c.entityType, c.entityId);
    if (input.action !== 'reject') {
      if (context.mailRegistry) check(JSON.stringify(context.mailRegistry) === JSON.stringify(db.prepare('SELECT id FROM mail_item ORDER BY id').all()), '분석 후 새 메일이 들어왔습니다. 최신 근거로 재분석하세요.', 409);
      const old = context.entities[`${c.entityType}:${c.entityId}`];
      if (old) check(old.row_version === target.row_version, '사용자 확정값이 변경되었습니다. 재분석하세요.', 409);
      if (c.kind === 'link') {
        const currentMatter = row(db, 'SELECT * FROM matter WHERE our_ref=? AND archived_at IS NULL', v.matterRef);
        check(currentMatter && context.entities[`matter:${currentMatter.id}`]?.row_version === currentMatter.row_version, '연결할 사건이 변경되었습니다. 재분석하세요.', 409);
      }
      const verifications = db.prepare(`SELECT * FROM analysis_candidate WHERE kind='risk' AND entity_id=? ORDER BY created_at DESC`).all(id) as Row[];
      if (directRelationshipFeedback) {
        check(verifications.length > 0, '독립 검증이 없는 관계 후보입니다. 먼저 고위험 검증을 실행하세요.', 409);
        check(verifications.every(r => values(JSON.parse(r.payload_json)).verdict !== 'rejected'), '독립 검증에서 반려된 후보입니다. 새 근거로 재분석하세요.', 409);
      }
      else check(verifications.every(r => values(JSON.parse(r.payload_json)).verdict === 'confirmed'), '독립 검증에서 반려 또는 사람 검토로 분류되었습니다. 재분석하세요.', 409);
      if (c.kind === 'action') {
        for (const [key, table] of [['works', 'work_item'], ['actions', 'action_item']] as const) {
          const previous = context[key].filter((item: Row) => item.matter_id === c.entityId).map((item: Row) => [item.id, item.row_version]).sort();
          const current = (db.prepare(`SELECT id,row_version FROM ${table} WHERE matter_id=? AND archived_at IS NULL`).all(c.entityId) as Row[]).map(item => [item.id, item.row_version]).sort();
          check(JSON.stringify(previous) === JSON.stringify(current), '업무 또는 Action이 변경되었습니다. 최신 상태로 재분석하세요.', 409);
        }
      }
      if (!directRelationshipFeedback && (original.risk_level === 'high' || riskLevel(edited) === 'high')) {
        check(input.action !== 'edit' || JSON.stringify(v) === JSON.stringify(values(c)), '고위험 수정값은 새 검증이 필요합니다. 기존 후보를 반려하고 재분석하세요.', 409);
        check(verifications.length > 0 && verifications.every(r => values(JSON.parse(r.payload_json)).verdict === 'confirmed'), '독립 고위험 검증 확인이 필요합니다. 충돌·미확인은 반영할 수 없습니다.', 409);
      }
    }
    const eventId = randomUUID();
    let final = input.action === 'reject' ? null : v;
    let appliedType = c.entityType, appliedId = c.entityId;
    if (input.action !== 'reject') {
      const evidenceMailIds = [...new Set(Object.values(c.fields).flatMap(f => f.evidence.map(e => e.mailId)))];
      if (c.kind === 'fact') {
        const date = new Date(new Date(sourceMail(db, evidenceMailIds[0]).mail_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
        // Insert the event first because entries have an immediate FK.
        db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,'analysis.accept',?,'장진태','user_input',?,?)`).run(eventId, appliedType, appliedId, JSON.stringify(final), id, stamp());
        db.prepare(`INSERT INTO knowledge_entry(id,entity_type,entity_id,entry_date,content,candidate_id,event_id,source_mail_ids_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(randomUUID(), c.entityType, c.entityId, date, v.summary, id, eventId, JSON.stringify(evidenceMailIds), stamp());
      } else if (c.kind === 'link') {
        const matter = row(db, 'SELECT * FROM matter WHERE our_ref=? AND archived_at IS NULL', v.matterRef); check(matter, '연결할 사건이 없습니다.');
        if (v.partyType) {
          const source = sourceMail(db, c.entityId);
          check(hasExactMatterReference(source.subject, v.matterRef) || hasExactMatterReference(source.body_text, v.matterRef), '관계 후보에는 전체 사건번호 일치가 필요합니다.');
          let selected: Row | undefined;
          if (directRelationshipFeedback && input.existingPartyId) {
            const table = v.partyType === 'organization' ? 'organization' : 'person';
            selected = row(db, `SELECT * FROM ${table} WHERE id=? AND archived_at IS NULL`, input.existingPartyId);
            check(selected && row(db, 'SELECT 1 ok FROM matter_party WHERE matter_id=? AND party_type=? AND party_id=?', matter.id, v.partyType, selected.id), '이 사건에 이미 연결된 대상을 선택하세요.', 409);
            v = { ...v, name: selected.name, email: v.partyType === 'person' ? selected.email : null };
            final = v;
          }
          const matches = selected ? [selected] : (v.partyType === 'organization'
            ? db.prepare('SELECT * FROM organization WHERE name=? COLLATE NOCASE AND archived_at IS NULL').all(v.name)
            : db.prepare('SELECT * FROM person WHERE email=? COLLATE NOCASE AND archived_at IS NULL').all(v.email)) as Row[];
          check(matches.length <= 1, '동일 식별 정보의 대상이 여러 개입니다. 병합하지 않고 검토하세요.', 409);
          const existing = matches[0];
          if (existing) {
            check(existing.name === v.name, '같은 이메일에 다른 이름이 있습니다. 동명이인·공용 주소를 확인하세요.', 409);
            const previous = context.entities[`${v.partyType}:${existing.id}`];
            check(directRelationshipFeedback && selected ? true : previous ? previous.row_version === existing.row_version : existing.source_type === 'user_input' && existing.source_id && row(db, 'SELECT run_id FROM analysis_candidate WHERE id=?', existing.source_id)?.run_id === original.run_id, '관계 대상이 분석 후 생성·수정되었습니다. 재분석하세요.', 409);
          } else if (v.partyType === 'person') {
            check(!row(db, 'SELECT id FROM person WHERE name=? AND archived_at IS NULL', v.name), '동명이인 또는 이메일 변경 가능성이 있습니다. 별도 확인하세요.', 409);
          }
          appliedType = v.partyType; appliedId = existing?.id || randomUUID();
          if (!existing) {
            if (v.partyType === 'organization') db.prepare(`INSERT INTO organization(id,name,business_type,source_type,source_id,confidence,user_confirmed,created_at,updated_at) VALUES (?,?,?,'user_input',?,1,1,?,?)`).run(appliedId, v.name, v.businessType, id, stamp(), stamp());
            else db.prepare(`INSERT INTO person(id,name,email,source_type,source_id,confidence,user_confirmed,created_at,updated_at) VALUES (?,?,?,'user_input',?,1,1,?,?)`).run(appliedId, v.name, v.email, id, stamp(), stamp());
          } else if (v.partyType === 'organization' && existing.business_type !== v.businessType) {
            check(existing.business_type === '미정' || directRelationshipFeedback, '사용자 확정 회사 구분과 충돌합니다.', 409);
            db.prepare(`UPDATE organization SET business_type=?,source_type='user_input',confidence=1,user_confirmed=1,row_version=row_version+1,updated_at=? WHERE id=?`).run(v.businessType, stamp(), existing.id);
          }
          db.prepare('INSERT OR IGNORE INTO matter_party(matter_id,party_type,party_id,role,created_at) VALUES (?,?,?,?,?)').run(matter.id, v.partyType, appliedId, v.role, stamp());
        } else db.prepare(`INSERT INTO mail_matter_link(mail_id,matter_id,match_source,confidence,created_at) VALUES (?,?,'user_input',1,?) ON CONFLICT(mail_id,matter_id) DO UPDATE SET match_source='user_input',confidence=1`).run(c.entityId, matter.id, stamp());
      } else if (c.kind === 'action' && v.required) {
        check(!row(db, `SELECT id FROM action_item WHERE matter_id=? AND title=? AND assignee=? AND archived_at IS NULL AND status IN ('대기','진행중','보류')`, c.entityId, v.title, v.assignee), '동일한 미완료 Action이 있습니다.', 409);
        appliedType = 'action'; appliedId = randomUUID();
        db.prepare(`INSERT INTO action_item(id,matter_id,title,assignee,manager,status,due_date,priority,evidence,source_type,source_id,confidence,user_confirmed,created_at,updated_at) VALUES (?,?,?,?,'장진태','대기',?,?,?,'user_input',?,1,1,?,?)`).run(appliedId, c.entityId, v.title, v.assignee, v.dueDate, v.priority, Object.values(c.fields).flatMap(f => f.evidence.map(e => e.quote)).filter((x, i, a) => a.indexOf(x) === i).join('\n'), id, stamp(), stamp());
      }
    }
    if (!row(db, 'SELECT id FROM event WHERE id=?', eventId)) db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,?,?,?,'장진태','user_input',?,?)`).run(eventId, appliedType, appliedId, `analysis.${input.action}`, JSON.stringify(values(c)), JSON.stringify(final), id, stamp());
    const review = ({ accept: 'accepted', edit: 'edited', reject: 'rejected', confirm_relationship: 'edited' } as Row)[input.action];
    for (const item of db.prepare('SELECT * FROM decision_item WHERE subject_key=?').all(id) as Row[]) {
      const key = item.field_path.split('.').slice(1).join('.');
      const finalValue = final ? final[key] : null;
      const equal = JSON.stringify(finalValue) === item.normalized_value_json;
      const feedbackId = randomUUID();
      db.prepare(`INSERT INTO user_feedback(id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,created_at) VALUES (?,?,?,'장진태',?,?,?,?,?,?)`).run(feedbackId, item.id, eventId, input.action === 'reject' ? 'reject' : equal ? 'accept' : 'edit', item.proposed_value_json, JSON.stringify(finalValue), directRelationshipFeedback ? 'new_evidence' : 'other', input.reason || null, stamp());
      // Comparison stays conservative: free-text/reasons/new evidence need human classification.
      db.prepare(`INSERT INTO decision_comparison(id,user_feedback_id,comparison_type,changed_paths_json,model_error_class,eligible_for_eval,excluded_reason,compared_at) VALUES (?,?,?,?,?,0,'분류 검토 전',?)`).run(randomUUID(), feedbackId, equal ? 'exact' : 'different', JSON.stringify(equal ? [] : [item.field_path]), equal ? 'correct' : 'unknown', stamp());
      db.prepare('UPDATE decision_item SET review_status=? WHERE id=?').run(input.action === 'reject' ? 'rejected' : equal ? 'accepted' : 'edited', item.id);
    }
    if (directRelationshipFeedback && !c.fields.businessType) {
      const feedbackId = randomUUID();
      db.prepare(`INSERT INTO user_feedback(id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,created_at) VALUES (?,NULL,?,'장진태','create_missing','null',?,'new_evidence',?,?)`).run(feedbackId, eventId, JSON.stringify(v.businessType), input.reason ?? null, stamp());
      db.prepare(`INSERT INTO decision_comparison(id,user_feedback_id,comparison_type,changed_paths_json,model_error_class,eligible_for_eval,excluded_reason,compared_at) VALUES (?,?,'different','["link.businessType"]','missing_field',0,'사용자 신규 분류',?)`).run(randomUUID(), feedbackId, stamp());
    }
    db.prepare('UPDATE analysis_candidate SET review_status=?,row_version=row_version+1,applied_event_id=? WHERE id=?').run(review, eventId, id);
    return { id, reviewStatus: review, eventId, appliedType, appliedId };
  }));
}
