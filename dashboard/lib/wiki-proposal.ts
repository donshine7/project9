import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { analysisPacket, analysisPolicy } from './analysis';
import { pathIsInside, resolveWikiVaultPath } from './runtime-environment';
import { parseWikiMarkdown, readWikiMarkdownSource } from './wiki-markdown';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;
type EvidenceKind = 'event' | 'source';
type EvidenceRecord = {
  kind: EvidenceKind;
  id: string;
  entityType: string;
  entityId: string;
  sourceHash: string;
  content: unknown;
};
export type WikiProposalInput = {
  schemaVersion: number;
  runId: string;
  docId: string;
  baseByteHash: string;
  evidenceSnapshotHash: string;
  changeSummary: string;
  proposedMarkdown: string;
  evidence: Array<{
    blockId: string;
    sentence: string;
    references: Array<{ kind: EvidenceKind; id: string }>;
  }>;
};

const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function check(condition: unknown, message: string, status = 400, code = 'WIKI_PROPOSAL_VALIDATION'): asserts condition {
  if (!condition) throw new WorkDbError(message, status, code);
}
function text(value: unknown, max: number, label: string): asserts value is string {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label}이(가) 비어 있거나 너무 깁니다.`);
}
function row(db: DatabaseSync, sql: string, ...params: any[]) {
  return db.prepare(sql).get(...params) as Row | undefined;
}

function eventRecord(db: DatabaseSync, id: string): EvidenceRecord | null {
  const event = row(db, `SELECT id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,correlation_id,created_at FROM event WHERE id=?`, id);
  if (!event) return null;
  const entry = row(db, `SELECT id,entity_type,entity_id,entry_date,date_basis,content,provenance,event_id,evidence_json,source_candidate_id,supersedes_id,created_at FROM wiki_entry e WHERE event_id=? AND NOT EXISTS(SELECT 1 FROM wiki_entry n WHERE n.supersedes_id=e.id)`, id);
  if (!entry) return null;
  const content = { event, entry };
  return { kind: 'event', id, entityType: event.entity_type, entityId: event.entity_id, sourceHash: hash(content), content };
}

function sourceRecord(db: DatabaseSync, id: string): EvidenceRecord | null {
  const source = row(db, `SELECT id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,observed_at,confidence,user_confirmed FROM source_observation WHERE id=?`, id);
  if (!source) return null;
  if (!source.user_confirmed) {
    if (source.source_type !== 'easy_pat' || !source.source_id) return null;
    const verified = (db.prepare(`SELECT after_json FROM event WHERE entity_type=? AND entity_id=? AND event_type='easy_pat_verified' AND source_type='easy_pat'`).all(source.entity_type, source.entity_id) as Row[])
      .some((event) => {
        try { return JSON.parse(event.after_json).sourceId === source.source_id; } catch { return false; }
      });
    if (!verified) return null;
  }
  return { kind: 'source', id, entityType: source.entity_type, entityId: source.entity_id, sourceHash: hash(source), content: source };
}

function collectEvidence(db: DatabaseSync, entityType: string, entityId: string) {
  const events = (db.prepare(`SELECT event_id FROM wiki_entry e WHERE entity_type=? AND entity_id=? AND NOT EXISTS(SELECT 1 FROM wiki_entry n WHERE n.supersedes_id=e.id) ORDER BY event_id`).all(entityType, entityId) as Row[])
    .map((item) => eventRecord(db, item.event_id))
    .filter(Boolean) as EvidenceRecord[];
  const sources = (db.prepare(`SELECT id FROM source_observation WHERE entity_type=? AND entity_id=? ORDER BY id`).all(entityType, entityId) as Row[])
    .map((item) => sourceRecord(db, item.id))
    .filter(Boolean) as EvidenceRecord[];
  const records = [...events, ...sources].sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
  return { records, snapshotHash: hash(records.map((item) => [item.kind, item.id, item.sourceHash])) };
}

function entityVersion(db: DatabaseSync, entityType: string, entityId: string) {
  const tables: Record<string, string> = { matter: 'matter', organization: 'organization', person: 'person', group: 'matter_group' };
  const table = tables[entityType];
  check(table, '지원하지 않는 Wiki 엔티티입니다.');
  const entity = row(db, `SELECT id,row_version FROM ${table} WHERE id=? AND archived_at IS NULL`, entityId);
  check(entity, 'Wiki 엔티티가 없거나 보관되었습니다.', 404);
  return entity.row_version;
}

export async function prepareWikiMarkdownProposal(docId: string, retryOf?: string) {
  if (retryOf) {
    const previous = wikiMarkdownProposalPacket(retryOf) as any;
    check(previous.context.wikiMarkdown.docId === docId, '재처리할 Wiki 문서가 이전 실행과 다릅니다.', 409);
  }
  const source = await readWikiMarkdownSource(docId);
  check(!source.indexStale, '인덱스 이후 Markdown이 변경되었습니다. 먼저 다시 스캔하세요.', 409, 'WIKI_PROPOSAL_BASE_STALE');
  check(source.frontmatter.document_type === 'entity_wiki', '엔티티 Wiki 문서만 AI 개정 제안을 만들 수 있습니다.');
  const evidence = withDatabase((db) => collectEvidence(db, source.frontmatter.entity_type!, source.frontmatter.entity_id!));
  check(evidence.records.length > 0, '개정 제안에 사용할 검증된 event/source 근거가 없습니다.', 409, 'WIKI_PROPOSAL_EVIDENCE_REQUIRED');

  const policy = analysisPolicy();
  const projectRoot = process.env.SSPAT_PROJECT_ROOT || path.resolve(process.cwd(), '..');
  const contract = readFileSync(path.join(projectRoot, 'config', 'wiki-proposal-contract.md'), 'utf8');
  const route = policy.routes.wiki_revision;
  const promptVersion = `wiki-md-proposal-v1-${hash(contract + route.role).slice(0, 12)}`;
  const context = {
    mails: [],
    wikiMarkdown: {
      docId,
      documentType: source.frontmatter.document_type,
      entityType: source.frontmatter.entity_type,
      entityId: source.frontmatter.entity_id,
      title: source.frontmatter.title,
      relativePath: source.document.relative_path,
      baseRevisionId: source.revision?.id ?? null,
      baseByteHash: source.byteHash,
      baseTextHash: source.textHash,
      markdown: source.normalized,
      evidenceSnapshotHash: evidence.snapshotHash,
      admissibleEvidence: evidence.records,
    },
  };
  return withDatabase((db) => transaction(db, () => {
    const timestamp = now();
    const runId = randomUUID();
    const snapshotId = randomUUID();
    const policyId = `wiki-md-proposal-${hash({ contract, route }).slice(0, 40)}`;
    const version = entityVersion(db, source.frontmatter.entity_type!, source.frontmatter.entity_id!);
    db.prepare(`INSERT OR IGNORE INTO policy_revision(id,revision_type,version,artifact_paths_json,content_hash,status,created_at) VALUES (?,'workflow',?,?,?,'active',?)`)
      .run(policyId, promptVersion, JSON.stringify(['config/wiki-proposal-contract.md', 'config/wiki-proposal.schema.json', 'config/llm-routing.toml', route.configFile]), hash({ contract, route }), timestamp);
    db.prepare(`INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,'[]',?,'wiki-markdown-proposal-v1',?,?,?)`)
      .run(snapshotId, JSON.stringify({ [`${source.frontmatter.entity_type}:${source.frontmatter.entity_id}`]: version, [docId]: source.byteHash }), hash(context), JSON.stringify(context), timestamp);
    db.prepare(`INSERT INTO decision_run(id,operation,agent_name,prompt_version,policy_revision_id,routing_snapshot_json,input_snapshot_id,status,started_at,retry_of) VALUES (?,'wiki_markdown_proposal',?,?,?,?,?,'prepared',?,?)`)
      .run(runId, route.agent, promptVersion, policyId, JSON.stringify({ ...route, contract, promptVersion }), snapshotId, timestamp, retryOf ?? null);
    return {
      runId,
      docId,
      baseByteHash: source.byteHash,
      evidenceSnapshotHash: evidence.snapshotHash,
      evidenceCount: evidence.records.length,
      route: { agent: route.agent, model: route.model, effort: route.effort },
    };
  }));
}

export function wikiMarkdownProposalPacket(runId: string) {
  const packet = analysisPacket(runId) as any;
  check(packet.operation === 'wiki_markdown_proposal' && packet.context.wikiMarkdown, 'Markdown Wiki 제안 실행이 아닙니다.');
  return packet;
}

async function proposalTarget(vaultRoot: string, docId: string, proposalId: string) {
  const resolvedVault = await realpath(vaultRoot);
  let current = vaultRoot;
  for (const segment of ['80_Proposals', docId]) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      check(info.isDirectory() && !info.isSymbolicLink(), '제안 디렉터리가 실제 폴더가 아닙니다.', 409, 'WIKI_PROPOSAL_PATH_BLOCKED');
    } catch (error: any) {
      if (error instanceof WorkDbError) throw error;
      if (error?.code !== 'ENOENT') throw error;
      await mkdir(current);
    }
    const resolved = await realpath(current);
    check(pathIsInside(resolvedVault, resolved), '제안 경로가 Vault 밖을 가리킵니다.', 409, 'WIKI_PROPOSAL_PATH_BLOCKED');
  }
  return { absolutePath: path.join(current, `${proposalId}.md`), relativePath: `80_Proposals/${docId}/${proposalId}.md` };
}

function validateProposalInput(input: WikiProposalInput) {
  check(input?.schemaVersion === 1, 'Wiki 제안 출력 버전 오류');
  text(input.runId, 200, 'runId');
  text(input.docId, 132, 'docId');
  check(/^wiki-[a-z0-9][a-z0-9-]{2,127}$/.test(input.docId), 'docId 형식 오류');
  check(/^[a-f0-9]{64}$/.test(input.baseByteHash), 'baseByteHash 형식 오류');
  check(/^[a-f0-9]{64}$/.test(input.evidenceSnapshotHash), 'evidenceSnapshotHash 형식 오류');
  text(input.changeSummary, 1000, 'changeSummary');
  text(input.proposedMarkdown, 2 * 1024 * 1024, 'proposedMarkdown');
  check(Array.isArray(input.evidence) && input.evidence.length > 0 && input.evidence.length <= 300, '문장별 근거 목록 오류');
}

export async function ingestWikiMarkdownProposal(input: WikiProposalInput) {
  validateProposalInput(input);
  const packet = wikiMarkdownProposalPacket(input.runId);
  const frozen = packet.context.wikiMarkdown as Row;
  check(frozen.docId === input.docId, '실행과 제안 문서가 다릅니다.');
  check(frozen.baseByteHash === input.baseByteHash, '제안 base hash가 실행 입력과 다릅니다.', 409, 'WIKI_PROPOSAL_BASE_MISMATCH');
  check(frozen.evidenceSnapshotHash === input.evidenceSnapshotHash, '제안 근거 snapshot이 실행 입력과 다릅니다.', 409, 'WIKI_PROPOSAL_EVIDENCE_MISMATCH');
  const resultHash = hash(input);
  const run = withDatabase((db) => row(db, 'SELECT * FROM decision_run WHERE id=?', input.runId)!);
  if (run.status === 'succeeded') {
    check(run.output_hash === resultHash, '기존 Wiki 제안 결과를 덮어쓸 수 없습니다.', 409);
    return { proposal: withDatabase((db) => row(db, 'SELECT * FROM wiki_proposal WHERE run_id=?', input.runId)), duplicate: true };
  }
  check(run.status === 'started' && run.execution_ref && run.model, '실제 모델 실행을 먼저 연결하세요.', 409);

  const source = await readWikiMarkdownSource(input.docId);
  check(!source.indexStale && source.byteHash === input.baseByteHash, '사람 편집 또는 파일 변경으로 제안 base가 오래되었습니다.', 409, 'WIKI_PROPOSAL_BASE_STALE');
  const currentEvidence = withDatabase((db) => collectEvidence(db, frozen.entityType, frozen.entityId));
  check(currentEvidence.snapshotHash === input.evidenceSnapshotHash, '근거가 변경되었습니다. 최신 입력으로 다시 제안하세요.', 409, 'WIKI_PROPOSAL_EVIDENCE_STALE');

  const parsed = parseWikiMarkdown(Buffer.from(input.proposedMarkdown, 'utf8'));
  check(parsed.frontmatter.doc_id === frozen.docId, '제안이 doc_id를 변경했습니다.');
  check(parsed.frontmatter.document_type === frozen.documentType, '제안이 문서 유형을 변경했습니다.');
  check(parsed.frontmatter.entity_type === frozen.entityType && parsed.frontmatter.entity_id === frozen.entityId, '제안이 엔티티 연결을 변경했습니다.');
  const knownEvidence = new Map((frozen.admissibleEvidence as EvidenceRecord[]).map((item) => [`${item.kind}:${item.id}`, item]));
  const seenBlocks = new Set<string>();
  const evidenceRows: Array<{ blockId: string; sentenceHash: string; record: EvidenceRecord }> = [];
  for (const item of input.evidence) {
    check(/^[a-z0-9][a-z0-9-]{2,99}$/.test(item.blockId) && !seenBlocks.has(item.blockId), 'blockId 형식 또는 중복 오류');
    seenBlocks.add(item.blockId);
    text(item.sentence, 2000, '근거 문장');
    check(parsed.body.includes(item.sentence), '근거 문장이 제안 Markdown 본문에 없습니다.');
    check(Array.isArray(item.references) && item.references.length > 0 && item.references.length <= 10, '문장별 근거 참조 수 오류');
    const seenReferences = new Set<string>();
    for (const reference of item.references) {
      const key = `${reference.kind}:${reference.id}`;
      check(['event', 'source'].includes(reference.kind) && !seenReferences.has(key), '근거 참조 형식 또는 중복 오류');
      seenReferences.add(key);
      const record = knownEvidence.get(key);
      check(record, '입력에 없거나 다른 엔티티의 근거입니다.');
      check(record.entityType === frozen.entityType && record.entityId === frozen.entityId, '다른 엔티티의 근거입니다.');
      evidenceRows.push({ blockId: item.blockId, sentenceHash: hash(item.sentence), record });
    }
  }

  const targetBytes = Buffer.from(parsed.normalized, 'utf8');
  const targetByteHash = hash(targetBytes);
  const proposalId = `wiki-proposal-${hash(`${input.runId}:${targetByteHash}`).slice(0, 24)}`;
  const operationId = `wiki-operation-${hash(proposalId).slice(0, 24)}`;
  const target = await proposalTarget(resolveWikiVaultPath(), input.docId, proposalId);
  const timestamp = now();
  withDatabase((db) => transaction(db, () => {
    const existing = row(db, 'SELECT * FROM wiki_proposal WHERE run_id=?', input.runId);
    if (existing) {
      check(existing.id === proposalId && existing.target_byte_hash === targetByteHash, '기존 제안 준비 상태와 출력이 다릅니다.', 409);
      return;
    }
    db.prepare(`INSERT INTO wiki_file_operation(id,operation_type,subject_id,status,base_byte_hash,target_byte_hash,relative_path,created_at,updated_at) VALUES (?,'proposal_write',?,'prepared',?,?,?,?,?)`)
      .run(operationId, proposalId, input.baseByteHash, targetByteHash, target.relativePath, timestamp, timestamp);
    db.prepare(`INSERT INTO wiki_proposal(id,run_id,doc_id,operation_id,base_revision_id,base_byte_hash,base_text_hash,evidence_snapshot_hash,proposal_relative_path,proposal_byte_hash,target_byte_hash,change_summary,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'prepared',?,?)`)
      .run(proposalId, input.runId, input.docId, operationId, frozen.baseRevisionId, input.baseByteHash, frozen.baseTextHash, input.evidenceSnapshotHash, target.relativePath, targetByteHash, targetByteHash, input.changeSummary, timestamp, timestamp);
    const insertEvidence = db.prepare(`INSERT INTO wiki_proposal_evidence(id,proposal_id,block_id,sentence_hash,source_kind,source_id,source_hash,validation_status,checked_at) VALUES (?,?,?,?,?,?,?,'valid',?)`);
    for (const item of evidenceRows) insertEvidence.run(randomUUID(), proposalId, item.blockId, item.sentenceHash, item.record.kind, item.record.id, item.record.sourceHash, timestamp);
  }));

  try {
    try {
      await writeFile(target.absolutePath, targetBytes, { flag: 'wx' });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = await readFile(target.absolutePath);
      check(hash(existing) === targetByteHash, '기존 제안 파일과 대상 hash가 다릅니다.', 409, 'WIKI_PROPOSAL_FILE_CONFLICT');
    }
    withDatabase((db) => db.prepare(`UPDATE wiki_file_operation SET status='file_written',updated_at=? WHERE id=?`).run(now(), operationId));
    const targetInfo = await lstat(target.absolutePath);
    check(targetInfo.isFile() && !targetInfo.isSymbolicLink(), '제안 산출물이 실제 파일이 아닙니다.', 409, 'WIKI_PROPOSAL_PATH_BLOCKED');
    const actual = await readFile(target.absolutePath);
    check(hash(actual) === targetByteHash, '제안 파일 검증 hash가 다릅니다.', 409, 'WIKI_PROPOSAL_FILE_CONFLICT');
    withDatabase((db) => db.prepare(`UPDATE wiki_file_operation SET status='verified',updated_at=? WHERE id=?`).run(now(), operationId));
    return withDatabase((db) => transaction(db, () => {
      const completed = now();
      db.prepare(`UPDATE wiki_file_operation SET status='succeeded',updated_at=? WHERE id=?`).run(completed, operationId);
      db.prepare(`UPDATE wiki_proposal SET status='ready_for_review',updated_at=? WHERE id=?`).run(completed, proposalId);
      const result = { proposalId, docId: input.docId, proposalPath: target.relativePath, baseByteHash: input.baseByteHash, targetByteHash, evidenceSnapshotHash: input.evidenceSnapshotHash };
      db.prepare(`UPDATE decision_run SET status='succeeded',result_json=?,output_hash=?,completed_at=? WHERE id=?`).run(JSON.stringify(result), resultHash, completed, input.runId);
      return { proposal: row(db, 'SELECT * FROM wiki_proposal WHERE id=?', proposalId), duplicate: false };
    }));
  } catch (error) {
    withDatabase((db) => transaction(db, () => {
      const status = error instanceof WorkDbError && error.code === 'WIKI_PROPOSAL_FILE_CONFLICT' ? 'conflict' : 'failed';
      db.prepare(`UPDATE wiki_file_operation SET status=?,error_code=?,updated_at=? WHERE id=?`).run(status, error instanceof WorkDbError ? error.code : 'WIKI_PROPOSAL_WRITE_FAILED', now(), operationId);
      db.prepare(`UPDATE wiki_proposal SET status='failed',updated_at=? WHERE id=?`).run(now(), proposalId);
    }));
    throw error;
  }
}

export async function reconcileWikiMarkdownProposal(proposalId: string) {
  text(proposalId, 200, 'proposalId');
  const state = withDatabase((db) => {
    const proposal = row(db, 'SELECT p.*,d.entity_type,d.entity_id FROM wiki_proposal p JOIN wiki_document d ON d.doc_id=p.doc_id WHERE p.id=?', proposalId);
    check(proposal, 'Wiki 제안을 찾을 수 없습니다.', 404);
    return proposal;
  });
  let source: Awaited<ReturnType<typeof readWikiMarkdownSource>> | null = null;
  try { source = await readWikiMarkdownSource(state.doc_id); } catch { source = null; }
  return withDatabase((db) => transaction(db, () => {
    const proposal = row(db, 'SELECT * FROM wiki_proposal WHERE id=?', proposalId)!;
    const currentEvidence = collectEvidence(db, state.entity_type, state.entity_id);
    const evidenceStale = currentEvidence.snapshotHash !== proposal.evidence_snapshot_hash;
    const checkedAt = now();
    for (const evidence of db.prepare('SELECT * FROM wiki_proposal_evidence WHERE proposal_id=?').all(proposalId) as Row[]) {
      const current = evidence.source_kind === 'event' ? eventRecord(db, evidence.source_id) : sourceRecord(db, evidence.source_id);
      const validation = !current ? 'missing'
        : current.entityType !== state.entity_type || current.entityId !== state.entity_id ? 'wrong_entity'
          : current.sourceHash !== evidence.source_hash ? 'changed' : 'valid';
      db.prepare('UPDATE wiki_proposal_evidence SET validation_status=?,checked_at=? WHERE id=?').run(validation, checkedAt, evidence.id);
    }
    let status = proposal.status;
    if (proposal.status !== 'rejected') {
      if (source && !source.indexStale && source.byteHash === proposal.target_byte_hash) status = 'applied_observed';
      else if (!source || source.indexStale || source.byteHash !== proposal.base_byte_hash) status = 'stale_document';
      else if (evidenceStale) status = 'stale_evidence';
      else if (proposal.status !== 'reviewed') status = 'ready_for_review';
    }
    if (status !== proposal.status) db.prepare('UPDATE wiki_proposal SET status=?,row_version=row_version+1,updated_at=? WHERE id=?').run(status, checkedAt, proposalId);
    else db.prepare('UPDATE wiki_proposal SET updated_at=? WHERE id=?').run(checkedAt, proposalId);
    return { proposalId, status, evidenceStale, currentByteHash: source?.byteHash ?? null, activeFileChanged: !source || source.indexStale || source.byteHash !== proposal.base_byte_hash };
  }));
}

export async function reviewWikiMarkdownProposal(proposalId: string, action: 'accept_for_manual_apply' | 'reject', expectedVersion: number, reviewer = '장진태') {
  check(['accept_for_manual_apply', 'reject'].includes(action), 'Wiki 제안 검토 동작 오류');
  check(reviewer === '장진태', 'Wiki 제안 검토자는 인증된 사용자 장진태여야 합니다.', 403, 'WIKI_PROPOSAL_REVIEWER_INVALID');
  await reconcileWikiMarkdownProposal(proposalId);
  return withDatabase((db) => transaction(db, () => {
    const proposal = row(db, 'SELECT p.*,d.entity_type,d.entity_id FROM wiki_proposal p JOIN wiki_document d ON d.doc_id=p.doc_id WHERE p.id=?', proposalId);
    check(proposal, 'Wiki 제안을 찾을 수 없습니다.', 404);
    if (action === 'accept_for_manual_apply' && proposal.status === 'reviewed') return { proposalId, status: 'reviewed', duplicate: true };
    check(proposal.row_version === expectedVersion, '제안이 변경되었습니다. 새로고침하세요.', 409);
    if (action === 'accept_for_manual_apply') check(proposal.status === 'ready_for_review', '현재 문서 또는 근거가 변경되어 이 제안을 검토 승인할 수 없습니다.', 409);
    else check(!['applied_observed', 'rejected'].includes(proposal.status), '이미 적용 관측 또는 반려된 제안입니다.', 409);
    const timestamp = now();
    const eventId = randomUUID();
    db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,after_json,actor,source_type,correlation_id,created_at) VALUES (?,?,?,?,?,?, 'user_input',?,?)`)
      .run(eventId, proposal.entity_type, proposal.entity_id, action === 'accept_for_manual_apply' ? 'wiki.proposal_reviewed' : 'wiki.proposal_rejected', JSON.stringify({ proposalId, baseByteHash: proposal.base_byte_hash, targetByteHash: proposal.target_byte_hash, evidenceSnapshotHash: proposal.evidence_snapshot_hash, automaticApply: false }), reviewer, proposalId, timestamp);
    db.prepare(`INSERT INTO wiki_proposal_review(id,proposal_id,action,reviewer,reviewed_base_byte_hash,reviewed_evidence_snapshot_hash,review_event_id,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), proposalId, action, reviewer, proposal.base_byte_hash, proposal.evidence_snapshot_hash, eventId, timestamp);
    const status = action === 'accept_for_manual_apply' ? 'reviewed' : 'rejected';
    db.prepare('UPDATE wiki_proposal SET status=?,reviewer=?,reviewed_at=?,row_version=row_version+1,updated_at=? WHERE id=?').run(status, reviewer, timestamp, timestamp, proposalId);
    return { proposalId, status, eventId, automaticApply: false, duplicate: false };
  }));
}

export function wikiMarkdownProposalDetail(proposalId: string) {
  return withDatabase((db) => {
    const proposal = row(db, 'SELECT * FROM wiki_proposal WHERE id=?', proposalId);
    check(proposal, 'Wiki 제안을 찾을 수 없습니다.', 404);
    return {
      proposal,
      operation: row(db, 'SELECT * FROM wiki_file_operation WHERE id=?', proposal.operation_id),
      evidence: db.prepare('SELECT * FROM wiki_proposal_evidence WHERE proposal_id=? ORDER BY block_id,source_kind,source_id').all(proposalId),
      reviews: db.prepare('SELECT * FROM wiki_proposal_review WHERE proposal_id=? ORDER BY created_at').all(proposalId),
    };
  });
}
