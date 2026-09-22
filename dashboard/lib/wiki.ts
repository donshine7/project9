import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { analysisPacket, analysisPolicy, prepareAnalysis } from './analysis';
import { hasExactMatterReference } from './matter-number';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;
type Sentence = { text: string; entryDate: string | null; eventIds: string[] };
type Section = { key: string; title: string; sentences: Sentence[] };
type WikiResult = { schemaVersion: number; runId: string; changeSummary: string; sections: Section[] };
const tables: Record<string, string> = { matter: 'matter', organization: 'organization', person: 'person', group: 'matter_group' };
const sectionTitles: Record<string, string> = { overview: '현재 요약', timeline: '날짜별 중요내용', issues: '확인할 사항' };
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function check(value: unknown, message: string, status = 400): asserts value { if (!value) throw new WorkDbError(message, status, 'WIKI_VALIDATION'); }
function text(value: unknown, max = 4000): asserts value is string { check(typeof value === 'string' && value.trim() && value.length <= max, '내용이 비어 있거나 너무 깁니다.'); }
function get(db: DatabaseSync, sql: string, ...params: string[]) { return db.prepare(sql).get(...params) as Row | undefined; }
function target(db: DatabaseSync, type: string, id: string) {
  check(Object.hasOwn(tables, type), 'Wiki 대상 유형 오류');
  const value = get(db, `SELECT * FROM ${tables[type]} WHERE id=? AND archived_at IS NULL`, id);
  check(value, '대상이 없거나 보관되었습니다.', 404); return value;
}
function date(value: string) { check(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, '실재하는 YYYY-MM-DD 날짜를 입력하세요.'); return value; }
function audit(db: DatabaseSync, type: string, id: string, eventType: string, before: unknown, after: unknown, actor = '장진태', source = 'user_input') {
  const eventId = randomUUID();
  db.prepare('INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(eventId, type, id, eventType, JSON.stringify(before), JSON.stringify(after), actor, source, now());
  return eventId;
}
function activeEntries(db: DatabaseSync, type: string, id: string): Row[] {
  return (db.prepare(`SELECT e.* FROM wiki_entry e WHERE e.entity_type=? AND e.entity_id=? AND NOT EXISTS(SELECT 1 FROM wiki_entry n WHERE n.supersedes_id=e.id) ORDER BY e.entry_date,e.created_at,e.id`).all(type, id) as Row[]).map(e => {
    const evidence = JSON.parse(e.evidence_json);
    return { ...e, evidence, eventHash: hash(get(db, 'SELECT * FROM event WHERE id=?', e.event_id)), mailHashes: [...new Set<string>(evidence.map((x: Row) => x.mailId))].sort().map(mailId => ({ mailId, hash: hash(get(db, 'SELECT * FROM mail_item WHERE id=?', mailId)) })) };
  });
}
function snapshot(db: DatabaseSync, type: string, id: string) {
  const entity = target(db, type, id);
  const members = type === 'matter' ? [id] : type === 'group'
    ? (db.prepare('SELECT matter_id FROM matter_group_member WHERE group_id=? ORDER BY matter_id').all(id) as Row[]).map(r => r.matter_id)
    : (db.prepare('SELECT DISTINCT matter_id FROM matter_party WHERE party_type=? AND party_id=? ORDER BY matter_id').all(type, id) as Row[]).map(r => r.matter_id);
  const matters = members.map(m => get(db, 'SELECT * FROM matter WHERE id=? AND archived_at IS NULL', m)).filter(Boolean);
  const works = matters.flatMap(m => db.prepare('SELECT * FROM work_item WHERE matter_id=? AND archived_at IS NULL ORDER BY id').all(m!.id));
  const actions = matters.flatMap(m => db.prepare('SELECT * FROM action_item WHERE matter_id=? AND archived_at IS NULL ORDER BY id').all(m!.id));
  const assignments = (works as Row[]).flatMap(w => db.prepare('SELECT * FROM assignment WHERE work_item_id=? AND archived_at IS NULL ORDER BY id').all(w.id));
  const parties = matters.flatMap(m => db.prepare('SELECT * FROM matter_party WHERE matter_id=? ORDER BY party_type,party_id,role').all(m!.id));
  const entries = activeEntries(db, type, id);
  const previous = get(db, 'SELECT * FROM entity_wiki_revision WHERE entity_type=? AND entity_id=? ORDER BY version DESC LIMIT 1', type, id) || null;
  if (type === 'group') {
    entity.representative_our_ref = entity.representative_matter_id
      ? get(db, 'SELECT our_ref FROM matter WHERE id=? AND archived_at IS NULL', entity.representative_matter_id)?.our_ref || null
      : null;
    entity.member_refs = matters.map(m => m!.our_ref).sort((a, b) => a.localeCompare(b, 'ko'));
  }
  return { type, id, entity, matters, works, actions, assignments, parties, entries, baseVersion: previous?.version || 0, previous };
}
function sourceFingerprint(context: Row) { return hash({ ...context, previous: undefined, baseVersion: undefined }); }
function sourceIssues(db: DatabaseSync, entries: Row[]) {
  return entries.filter(e => {
    if (!e.source_candidate_id) return false;
    const candidate = get(db, 'SELECT review_status FROM analysis_candidate WHERE id=?', e.source_candidate_id);
    const verdicts = (db.prepare(`SELECT payload_json FROM analysis_candidate WHERE kind='risk' AND entity_id=?`).all(e.source_candidate_id) as Row[]).map(v => JSON.parse(v.payload_json).fields.verdict.value);
    return !candidate || !['pending','accepted'].includes(candidate.review_status) || !verdicts.length || verdicts.some(v => v !== 'confirmed');
  }).map(e => e.id);
}

export function wikiIndex(query = '') {
  return withDatabase(db => {
    const list: Row[] = [];
    for (const [type, table] of Object.entries(tables)) {
      const nameColumn = type === 'matter' ? 'our_ref' : type === 'group' ? 'group_ref' : 'name';
      for (const r of db.prepare(`SELECT id,${nameColumn} AS label,note,row_version FROM ${table} WHERE archived_at IS NULL AND ${nameColumn} LIKE ? ORDER BY ${nameColumn}`).all(`%${query.slice(0, 100)}%`) as Row[]) {
        const revision = get(db, 'SELECT version FROM entity_wiki_revision WHERE entity_type=? AND entity_id=? ORDER BY version DESC LIMIT 1', type, r.id);
        list.push({ ...r, type, version: revision?.version || 0, entryCount: activeEntries(db, type, r.id).length });
      }
    }
    return list;
  });
}
export function wikiDetail(type: string, id: string) {
  return withDatabase(db => {
    const context = snapshot(db, type, id);
    const revisions = (db.prepare('SELECT w.*,r.model,r.reasoning_effort,r.prompt_version FROM entity_wiki_revision w JOIN decision_run r ON r.id=w.run_id WHERE w.entity_type=? AND w.entity_id=? ORDER BY w.version DESC').all(type, id) as Row[]).map((r): Row => ({ ...r, sections: JSON.parse(r.sections_json) }));
    const drafts = (db.prepare('SELECT w.*,r.model,r.reasoning_effort FROM wiki_draft w JOIN decision_run r ON r.id=w.run_id WHERE w.entity_type=? AND w.entity_id=? ORDER BY w.created_at DESC').all(type, id) as Row[]).map((r): Row => ({ ...r, sections: JSON.parse(r.sections_json) }));
    const legacy = type === 'matter' ? db.prepare('SELECT * FROM wiki_revision WHERE matter_id=? ORDER BY version DESC').all(id) : [];
    const related = type === 'matter' ? [
      ...db.prepare(`SELECT 'organization' type,o.id,o.name label FROM organization o JOIN matter_party p ON p.party_id=o.id AND p.party_type='organization' WHERE p.matter_id=? AND o.archived_at IS NULL`).all(id),
      ...db.prepare(`SELECT 'person' type,o.id,o.name label FROM person o JOIN matter_party p ON p.party_id=o.id AND p.party_type='person' WHERE p.matter_id=? AND o.archived_at IS NULL`).all(id),
      ...db.prepare(`SELECT 'group' type,g.id,g.group_ref label FROM matter_group g JOIN matter_group_member m ON m.group_id=g.id WHERE m.matter_id=? AND g.archived_at IS NULL`).all(id),
    ] : context.matters.map(m => ({ type: 'matter', id: m!.id, label: m!.our_ref }));
    const issues = sourceIssues(db, context.entries);
    return { ...context, revisions, drafts, related, legacy, sourceIssues: issues, stale: Boolean(revisions[0] && (revisions[0].input_hash !== sourceFingerprint(context) || issues.length)) };
  });
}

export function addWikiEntry(type: string, id: string, input: { content: string; entryDate: string; expectedVersion: number; supersedesId?: string; reason?: string }) {
  text(input.content); date(input.entryDate);
  return withDatabase(db => transaction(db, () => {
    const entity = target(db, type, id); check(entity.row_version === input.expectedVersion, '대상이 변경되었습니다. 새로고침하세요.', 409);
    const before = input.supersedesId ? get(db, 'SELECT * FROM wiki_entry WHERE id=? AND entity_type=? AND entity_id=?', input.supersedesId, type, id) : null;
    if (input.supersedesId) check(before && !get(db, 'SELECT id FROM wiki_entry WHERE supersedes_id=?', input.supersedesId), '이미 수정되었거나 다른 대상의 기록입니다.', 409);
    const entryId = randomUUID();
    const eventId = audit(db, type, id, before ? 'wiki.entry_corrected' : 'wiki.entry_added', before, { entryId, content: input.content, date: input.entryDate });
    db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,supersedes_id,created_at) VALUES (?,?,?,?,'user_date',?,'user_input',?,?,?)`).run(entryId, type, id, input.entryDate, input.content, eventId, input.supersedesId || null, now());
    db.prepare(`INSERT INTO user_feedback(id,event_id,actor_id,feedback_action,before_value_json,final_value_json,reason_code,note,created_at) VALUES (?,?,'장진태',?,?,?,?,?,?)`).run(randomUUID(), eventId, before ? 'edit' : 'create_missing', JSON.stringify(before?.content || null), JSON.stringify(input.content), before ? 'other' : 'new_evidence', input.reason || null, now());
    return { entryId, eventId };
  }));
}

// Main-task only: does not accept a user candidate or mutate a business status.
// It records the narrower proposition "this verified email says X".
export function captureVerifiedMail(candidateId: string, matterId: string) {
  const input = withDatabase(db => { const c = get(db, `SELECT * FROM analysis_candidate WHERE id=? AND kind='fact' AND review_status IN ('pending','accepted')`, candidateId); check(c, '유효한 사실 후보가 없습니다. 사용자 수정·반려는 원래 모델 값보다 우선합니다.'); return c; });
  analysisPacket(input.run_id); // Source hash and frozen snapshot integrity.
  return withDatabase(db => transaction(db, () => {
    const matter = target(db, 'matter', matterId);
    const existing = get(db, `SELECT id FROM wiki_entry WHERE entity_type='matter' AND entity_id=? AND source_candidate_id=?`, matterId, candidateId);
    if (existing) return { entryId: existing.id, duplicate: true };
    const verdicts = (db.prepare(`SELECT payload_json FROM analysis_candidate WHERE kind='risk' AND entity_id=?`).all(candidateId) as Row[]).map(v => JSON.parse(v.payload_json).fields.verdict.value);
    check(verdicts.length > 0 && verdicts.every(v => v === 'confirmed'), '독립 검증에서 전부 확인된 사실만 기록할 수 있습니다.', 409);
    const c = JSON.parse(input.payload_json), mail = get(db, 'SELECT * FROM mail_item WHERE id=?', c.entityId);
    check(mail && get(db, 'SELECT mail_id FROM mail_matter_link WHERE mail_id=? AND matter_id=?', c.entityId, matterId), '메일·사건 연결이 없습니다.');
    check((hasExactMatterReference(mail.subject, matter.our_ref) || hasExactMatterReference(mail.body_text, matter.our_ref)) && hasExactMatterReference(c.fields.summary.value, matter.our_ref), '전체 관리번호가 직접 명시된 사건에 대해서만 관찰을 기록합니다.');
    const content = `메일 기재 내용(독립 검증됨, 업무 상태 확정 아님): ${c.fields.summary.value}`;
    const day = new Date(new Date(mail.mail_at).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
    const entryId = randomUUID(), evidence = c.fields.summary.evidence;
    const eventId = audit(db, 'matter', matterId, 'wiki.mail_observation_verified', null, { entryId, content, date: day, candidateId, evidence }, 'Codex', 'mail_inference');
    db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,evidence_json,source_candidate_id,created_at) VALUES (?,'matter',?,?,'mail_date',?,'verified_mail',?,?,?,?)`).run(entryId, matterId, day, content, eventId, JSON.stringify(evidence), candidateId, now());
    return { entryId, eventId, duplicate: false };
  }));
}

// Converts already user-accepted organization/person relationships into dated
// Wiki source entries. It does not infer a new party, role, or matter link.
export function captureAcceptedRelationshipEntries() {
  return withDatabase(db => transaction(db, () => {
    const candidates = (db.prepare(`SELECT * FROM analysis_candidate WHERE kind='link' AND review_status IN ('accepted','edited') AND applied_event_id IS NOT NULL ORDER BY created_at,id`).all() as Row[])
      .map(candidate => ({ candidate, payload: JSON.parse(candidate.payload_json) }))
      .filter(({ payload }) => ['organization', 'person'].includes(payload.fields?.partyType?.value));
    const context = candidates.map(({ candidate, payload }) => ({ id: candidate.id, eventId: candidate.applied_event_id, payloadHash: hash(payload) }));
    const contextHash = hash(context);
    const duplicate = get(db, `SELECT r.id,r.result_json FROM decision_run r JOIN input_snapshot s ON s.id=r.input_snapshot_id WHERE r.operation='relationship_wiki_capture' AND r.status='succeeded' AND s.context_hash=? LIMIT 1`, contextHash);
    if (duplicate) return { ...JSON.parse(duplicate.result_json), duplicate: true };

    const timestamp = now(), runId = randomUUID(), snapshotId = randomUUID();
    const policyId = 'relationship-wiki-capture-v1';
    const policyHash = hash('accepted-party-link-to-dated-wiki-source-v1');
    db.prepare(`INSERT OR IGNORE INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,created_at) VALUES (?,'workflow','relationship-wiki-capture-v1',?,?,'active',?)`)
      .run(policyId, JSON.stringify(['dashboard/lib/wiki.ts', 'docs/LLM_WIKI_DESIGN.md']), policyHash, timestamp);
    db.prepare(`INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,'[]','{}','accepted-user-relationship-v1',?,?,?)`)
      .run(snapshotId, contextHash, JSON.stringify({ relationships: context }), timestamp);
    db.prepare(`INSERT INTO decision_run(id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,input_snapshot_id,status,started_at) VALUES (?,'relationship_wiki_capture','deterministic_relationship_wiki_capture','relationship-wiki-capture-v1',?,'{"method":"deterministic","model":null,"effort":null}',?,'started',?)`)
      .run(runId, policyId, snapshotId, timestamp);

    let createdEntries = 0;
    for (const { candidate, payload } of candidates) {
      if (get(db, "SELECT id FROM event WHERE event_type='wiki.relationship_confirmed' AND correlation_id=?", candidate.id)) continue;
      const applied = get(db, 'SELECT * FROM event WHERE id=?', candidate.applied_event_id);
      const proposedValues = Object.fromEntries(Object.entries(payload.fields).map(([key, field]: [string, any]) => [key, field.value])) as Row;
      const appliedValues = applied?.after_json ? JSON.parse(applied.after_json) : null;
      const values = appliedValues?.matterRef && appliedValues?.partyType ? appliedValues : proposedValues;
      check(applied && applied.entity_type === values.partyType, '수락 관계의 적용 이벤트가 대상과 일치하지 않습니다.', 409);
      const matter = get(db, 'SELECT id FROM matter WHERE our_ref=? AND archived_at IS NULL', values.matterRef);
      check(matter && get(db, 'SELECT matter_id FROM matter_party WHERE matter_id=? AND party_type=? AND party_id=? AND role=?', matter.id, values.partyType, applied.entity_id, values.role), '수락된 회사·사람 관계가 현재 DB와 일치하지 않습니다.', 409);
      const sameRelationshipEntry = (db.prepare("SELECT after_json FROM event WHERE entity_type=? AND entity_id=? AND event_type='wiki.relationship_confirmed'").all(values.partyType, applied.entity_id) as Row[])
        .some(item => { try { const recorded = JSON.parse(item.after_json); return recorded.matterRef === values.matterRef && recorded.role === values.role; } catch { return false; } });
      if (sameRelationshipEntry) continue;
      const evidence = Object.values(payload.fields).flatMap((field: any) => field.evidence || []).filter((item: Row, index: number, all: Row[]) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) === index);
      const mailIds = [...new Set<string>(evidence.map((item: Row) => item.mailId))];
      check(mailIds.length > 0, '관계 Wiki 기록에는 메일 근거가 필요합니다.');
      const mails = mailIds.map(id => get(db, 'SELECT * FROM mail_item WHERE id=?', id));
      check(mails.every(Boolean), '관계 근거 메일을 찾을 수 없습니다.', 409);
      const day = new Date(new Date(mails[0]!.mail_at).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
      const contact = values.partyType === 'person' && values.email ? ` (${values.email})` : '';
      const content = `사용자 확인 관계: ${values.matterRef}의 ${values.role} — ${values.name}${contact}.`;
      const entryId = randomUUID();
      const eventId = audit(db, values.partyType, applied.entity_id, 'wiki.relationship_confirmed', null, { entryId, candidateId: candidate.id, matterRef: values.matterRef, role: values.role, content, date: day, evidence }, '장진태', 'user_input');
      db.prepare('UPDATE event SET correlation_id=? WHERE id=?').run(candidate.id, eventId);
      db.prepare(`INSERT INTO wiki_entry(id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,evidence_json,created_at) VALUES (?,?,?,?,'mail_date',?,'user_input',?,?,?)`)
        .run(entryId, values.partyType, applied.entity_id, day, content, eventId, JSON.stringify(evidence), timestamp);
      const decisionId = randomUUID();
      db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at) VALUES (?,?,?,?,'wiki.timeline','create',?,?,1,'low','이미 수락된 사건 관계를 대상별 날짜 기록으로 파생','accepted',?)`)
        .run(decisionId, runId, values.partyType, applied.entity_id, JSON.stringify(content), JSON.stringify(content), timestamp);
      for (const item of evidence) db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'mail',?,?,?,?,'support')`)
        .run(randomUUID(), decisionId, item.mailId, JSON.stringify({ field: item.field }), item.quote, hash(item.quote));
      createdEntries += 1;
    }
    const result = { runId, candidateCount: candidates.length, createdEntries, duplicate: false };
    db.prepare(`UPDATE decision_run SET status='succeeded',completed_at=?,output_hash=?,result_json=? WHERE id=?`).run(now(), hash(result), JSON.stringify(result), runId);
    return result;
  }));
}

export function prepareWiki(type: string, id: string, retryOf?: string) {
  const policy = analysisPolicy();
  const root = process.env.SSPAT_PROJECT_ROOT || path.resolve(process.cwd(), '..');
  const contract = readFileSync(path.join(root, 'config/wiki-contract.md'), 'utf8');
  return withDatabase(db => transaction(db, () => {
    const wiki = snapshot(db, type, id); check(wiki.entries.length > 0, '먼저 날짜별 기록을 추가하거나 검증된 메일 관찰을 연결하세요.', 409);
    check(!sourceIssues(db,wiki.entries).length, '메일 근거 검증 또는 사용자 판단이 변경되었습니다. 먼저 해당 기록을 정정하세요.', 409);
    if (retryOf) {
      const previousRun = get(db, 'SELECT * FROM decision_run WHERE id=?', retryOf);
      check(previousRun?.operation === 'wiki_revision', 'Wiki 실행만 재처리할 수 있습니다.');
      const previousSnapshot = get(db, 'SELECT context_json FROM input_snapshot WHERE id=?', previousRun.input_snapshot_id);
      const previousTarget = JSON.parse(previousSnapshot!.context_json).wiki;
      check(previousTarget.type === type && previousTarget.id === id, '재처리 대상이 다릅니다.');
    }
    const runId = randomUUID(), snapshotId = randomUUID();
    const route: Row = { ...policy.routes.wiki_revision, contract, promptVersion: `wiki-v1-${hash(contract + policy.routes.wiki_revision.role).slice(0,12)}` };
    const context = { mails: [], wiki };
    const revisionId = `wiki-${hash({ policy: policy.policyHash, contract })}`;
    db.prepare(`INSERT OR IGNORE INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,created_at) VALUES (?,'workflow',?,? ,?,'active',?)`).run(revisionId, revisionId, JSON.stringify(['config/wiki-contract.md','config/llm-routing.toml','config/agents/wiki-synthesizer.toml']), hash({ policy: policy.policyHash, contract }), now());
    db.prepare(`INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,'[]',?,'wiki-v1',?,?,?)`).run(snapshotId, JSON.stringify({ [type + ':' + id]: wiki.entity.row_version }), hash(context), JSON.stringify(context), now());
    db.prepare(`INSERT INTO decision_run(id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,input_snapshot_id,status,started_at,retry_of) VALUES (?,'wiki_revision',?,?,?,?,?,'prepared',?,?)`).run(runId, route.agent, route.promptVersion, revisionId, JSON.stringify(route), snapshotId, now(), retryOf || null);
    return { runId, route: { agent: route.agent, model: route.model, effort: route.effort }, entryCount: wiki.entries.length };
  }));
}
export function wikiPacket(runId: string) {
  const packet = analysisPacket(runId); check(packet.operation === 'wiki_revision' && packet.context.wiki, 'Wiki 실행이 아닙니다.'); return packet;
}
export function ingestWiki(result: WikiResult) {
  check(result?.schemaVersion === 1, 'Wiki 출력 버전 오류'); text(result.changeSummary, 1000);
  const packet = wikiPacket(result.runId), old = packet.context.wiki;
  return withDatabase(db => transaction(db, () => {
    const run = get(db, 'SELECT * FROM decision_run WHERE id=?', result.runId)!;
    if (run.status === 'succeeded') { check(run.output_hash === hash(result), '기존 결과를 덮어쓸 수 없습니다.', 409); return { runId: result.runId, duplicate: true }; }
    check(run.status === 'started' && run.execution_ref && run.model, '실제 모델 실행을 먼저 연결하세요.', 409);
    check(Array.isArray(result.sections) && result.sections.length > 0 && result.sections.length <= 3, 'Wiki 단락 형식 오류');
    const keys = new Set<string>();
    for (const section of result.sections) {
      check(sectionTitles[section.key] === section.title && !keys.has(section.key), 'Wiki 단락 이름·중복 오류'); keys.add(section.key);
      check(Array.isArray(section.sentences) && section.sentences.length > 0 && section.sentences.length <= 100, 'Wiki 문장 수 오류');
      for (const sentence of section.sentences) {
        text(sentence.text, 2000); check(Array.isArray(sentence.eventIds) && sentence.eventIds.length > 0 && sentence.eventIds.length <= 10 && new Set(sentence.eventIds).size === sentence.eventIds.length, '문장별 근거 이벤트가 필요합니다.');
        const refs = sentence.eventIds.map(eventId => { const entry = old.entries.find((e: Row) => e.event_id === eventId); check(entry, '입력에 없는/폐기된/다른 대상의 근거 이벤트입니다.'); return entry; });
        if (section.key === 'timeline') check(sentence.entryDate && refs.every((e: Row) => e.entry_date === sentence.entryDate), '날짜별 문장은 근거 날짜와 일치해야 합니다.');
        else check(sentence.entryDate === null, '날짜는 날짜별 단락에서만 사용하세요.');
        if (refs.every((e: Row) => e.provenance === 'verified_mail')) check(/메일/.test(sentence.text), '검증된 메일 기재 사실임을 문장에 표시하세요.');
      }
    }
    // Drafts can survive newer context; publication below rejects stale input.
    db.prepare('INSERT INTO wiki_draft(run_id,entity_type,entity_id,base_version,sections_json,change_summary,created_at) VALUES (?,?,?,?,?,?,?)').run(result.runId, old.type, old.id, old.baseVersion, JSON.stringify(result.sections), result.changeSummary, now());
    for (const section of result.sections) for (const [index, sentence] of section.sentences.entries()) {
      const decisionId = randomUUID();
      db.prepare(`INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,created_at) VALUES (?,?,'wiki_revision',?,?,'create',?,?,0,'medium','이벤트 근거 Wiki 개정 후보',?)`).run(decisionId, result.runId, result.runId, `wiki.${section.key}.${index}`, JSON.stringify(sentence.text), JSON.stringify(sentence.text), now());
      for (const eventId of sentence.eventIds) {
        const entry = old.entries.find((e: Row) => e.event_id === eventId);
        db.prepare(`INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'event',?,'{}',?,?,'support')`).run(randomUUID(), decisionId, eventId, entry.content, hash(entry.content));
      }
    }
    db.prepare(`UPDATE decision_run SET status='succeeded',result_json=?,output_hash=?,completed_at=? WHERE id=?`).run(JSON.stringify(result), hash(result), now(), result.runId);
    return { runId: result.runId, duplicate: false };
  }));
}

export function reviewWiki(runId: string, action: string, expectedVersion: number, actor: '장진태' | 'Codex' = '장진태') {
  check(['publish','reject'].includes(action), 'Wiki 검토 동작 오류');
  const packet = wikiPacket(runId);
  return withDatabase(db => transaction(db, () => {
    const draft = get(db, 'SELECT * FROM wiki_draft WHERE run_id=?', runId); check(draft, 'Wiki 초안이 없습니다.', 404);
    if (action === 'publish' && draft.review_status === 'published') return { revision: get(db, 'SELECT * FROM entity_wiki_revision WHERE run_id=?', runId), duplicate: true };
    check(draft.review_status === 'pending' && draft.row_version === expectedVersion, '이미 검토되었거나 변경된 초안입니다.', 409);
    const old = packet.context.wiki;
    if (action === 'publish') {
      const current = snapshot(db, draft.entity_type, draft.entity_id);
      check(!sourceIssues(db,current.entries).length, '메일 근거 검증 또는 사용자 판단이 변경되었습니다.', 409);
      check(sourceFingerprint(old) === sourceFingerprint(current) && current.baseVersion === draft.base_version, '기록·업무·관계 또는 Wiki가 변경되었습니다. 최신 입력으로 재생성하세요.', 409);
      for (const e of old.entries) {
        const evt = get(db, 'SELECT * FROM event WHERE id=?', e.event_id); check(evt, '근거 이벤트가 사라졌습니다.', 409);
        if (e.source_candidate_id) {
          const verdicts = (db.prepare(`SELECT payload_json FROM analysis_candidate WHERE kind='risk' AND entity_id=?`).all(e.source_candidate_id) as Row[]).map(v => JSON.parse(v.payload_json).fields.verdict.value);
          check(verdicts.length && verdicts.every(v => v === 'confirmed'), '메일 근거 검증이 변경되었습니다.', 409);
        }
      }
    }
    const eventId = audit(db, draft.entity_type, draft.entity_id, `wiki.${action}`, null, { runId, version: action === 'publish' ? draft.base_version + 1 : null }, actor, actor === 'Codex' ? 'llm_verified' : 'user_input');
    if (action === 'publish') db.prepare('INSERT INTO entity_wiki_revision(id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), draft.entity_type, draft.entity_id, draft.base_version + 1, runId, draft.sections_json, draft.change_summary, sourceFingerprint(old), eventId, now());
    db.prepare('UPDATE wiki_draft SET review_status=?,row_version=row_version+1 WHERE run_id=?').run(action === 'publish' ? 'published' : 'rejected', runId);
    for (const item of db.prepare('SELECT * FROM decision_item WHERE decision_run_id=?').all(runId) as Row[]) {
      db.prepare('UPDATE decision_item SET review_status=? WHERE id=?').run(actor === 'Codex' ? 'not_reviewed' : action === 'publish' ? 'accepted' : 'rejected', item.id);
      if (actor === '장진태') {
        const feedbackId = randomUUID();
        db.prepare(`INSERT INTO user_feedback(id,decision_item_id,event_id,actor_id,feedback_action,before_value_json,final_value_json,created_at) VALUES (?,?,?,'장진태',?,?,?,?)`).run(feedbackId, item.id, eventId, action === 'publish' ? 'accept' : 'reject', item.proposed_value_json, action === 'publish' ? item.proposed_value_json : 'null', now());
        db.prepare(`INSERT INTO decision_comparison(id,user_feedback_id,comparison_type,changed_paths_json,model_error_class,eligible_for_eval,excluded_reason,compared_at) VALUES (?,?,?,?,?,0,'자유문·사용자 이유 분류 전',?)`).run(randomUUID(),feedbackId,action === 'publish' ? 'exact' : 'different',JSON.stringify(action === 'publish' ? [] : [item.field_path]),action === 'publish' ? 'correct' : 'unknown',now());
      }
    }
    return { runId, status: action === 'publish' ? 'published' : 'rejected', version: draft.base_version + 1 };
  }));
}

export function retryRun(runId: string) {
  const old = analysisPacket(runId);
  const newRun = old.operation === 'wiki_revision' ? prepareWiki(old.context.wiki.type, old.context.wiki.id, runId) : prepareAnalysis(old.operation, old.mails.map((m: Row) => m.id));
  if (old.operation !== 'wiki_revision') withDatabase(db => db.prepare('UPDATE decision_run SET retry_of=? WHERE id=?').run(runId, newRun.runId));
  return newRun;
}
export function wikiEvidence(eventId: string) {
  return withDatabase(db => {
    const event = get(db, 'SELECT * FROM event WHERE id=?', eventId); check(event, '근거를 찾을 수 없습니다.', 404);
    const entry = get(db, 'SELECT * FROM wiki_entry WHERE event_id=?', eventId); check(entry, 'Wiki 근거 이벤트가 아닙니다.', 404);
    const evidence = JSON.parse(entry.evidence_json);
    return { event, entry, mails: [...new Set<string>(evidence.map((e: Row) => e.mailId))].map(id => { const m = get(db, 'SELECT id,subject,mail_at,sender_name,direction FROM mail_item WHERE id=?', id); return { ...m, excerpts: evidence.filter((e: Row) => e.mailId === id) }; }) };
  });
}
