import type { DatabaseSync } from 'node:sqlite';
import { wikiMarkdownDetail, wikiMarkdownIndex } from './wiki-markdown';
import { withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;

export type WikiReviewStatus =
  | 'reviewed'
  | 'needs_review'
  | 'evidence_stale'
  | 'missing'
  | 'duplicate_id'
  | 'conflict'
  | 'indexing'
  | 'up_to_date';

export type WikiReviewIndexItem = Row & {
  docId: string;
  currentByteHash: string | null;
  indexedByteHash: string | null;
  indexStale: boolean;
  status: WikiReviewStatus;
  statusLabel: string;
  statusTone: string;
  latestProposal: ReturnType<typeof proposalSummary>;
};

export const wikiReviewStatusMeta: Record<WikiReviewStatus, { label: string; tone: string }> = {
  reviewed: { label: '검토 완료', tone: 'reviewed' },
  needs_review: { label: '검토 필요', tone: 'warning' },
  evidence_stale: { label: '근거 변경', tone: 'danger' },
  missing: { label: '파일 누락', tone: 'danger' },
  duplicate_id: { label: 'ID 중복', tone: 'warning' },
  conflict: { label: '충돌', tone: 'danger' },
  indexing: { label: '인덱싱 중', tone: 'info' },
  up_to_date: { label: '최신', tone: 'success' },
};

export function deriveWikiReviewStatus(input: {
  latestScanStatus?: string | null;
  parseStatus?: string | null;
  indexStale?: boolean;
  currentByteHash?: string | null;
  proposalStatus?: string | null;
  reviewedBaseByteHash?: string | null;
  targetByteHash?: string | null;
}): WikiReviewStatus {
  if (input.latestScanStatus === 'running') return 'indexing';
  if (input.parseStatus === 'missing') return 'missing';
  if (input.parseStatus === 'duplicate') return 'duplicate_id';
  if (['invalid', 'binding_conflict', 'entity_missing'].includes(String(input.parseStatus))) return 'conflict';
  if (input.indexStale || ['stale_document', 'failed'].includes(String(input.proposalStatus))) return 'conflict';
  if (input.proposalStatus === 'stale_evidence') return 'evidence_stale';
  if (['prepared', 'ready_for_review'].includes(String(input.proposalStatus))) return 'needs_review';
  if (
    input.proposalStatus === 'applied_observed'
    && input.currentByteHash
    && input.currentByteHash === input.targetByteHash
  ) return 'up_to_date';
  if (
    input.proposalStatus === 'reviewed'
    && input.currentByteHash
    && input.currentByteHash === input.reviewedBaseByteHash
  ) return 'reviewed';
  if (input.reviewedBaseByteHash && input.currentByteHash === input.reviewedBaseByteHash) return 'up_to_date';
  return 'needs_review';
}

function proposalRows(db: DatabaseSync) {
  return db.prepare(`
    SELECT
      p.*,
      (
        SELECT r.reviewed_base_byte_hash
        FROM wiki_proposal_review r
        WHERE r.proposal_id=p.id
        ORDER BY r.created_at DESC,r.id DESC
        LIMIT 1
      ) AS reviewed_base_byte_hash,
      (
        SELECT r.reviewed_evidence_snapshot_hash
        FROM wiki_proposal_review r
        WHERE r.proposal_id=p.id
        ORDER BY r.created_at DESC,r.id DESC
        LIMIT 1
      ) AS reviewed_evidence_snapshot_hash
    FROM wiki_proposal p
    ORDER BY p.doc_id,p.created_at DESC,p.id DESC
  `).all() as Row[];
}

function latestProposals() {
  return withDatabase((db) => {
    const byDocument = new Map<string, Row>();
    for (const proposal of proposalRows(db)) {
      if (!byDocument.has(proposal.doc_id)) byDocument.set(proposal.doc_id, proposal);
    }
    return byDocument;
  });
}

function proposalSummary(row: Row | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    changeSummary: row.change_summary,
    baseByteHash: row.base_byte_hash,
    targetByteHash: row.target_byte_hash,
    evidenceSnapshotHash: row.evidence_snapshot_hash,
    reviewedBaseByteHash: row.reviewed_base_byte_hash ?? null,
    reviewedEvidenceSnapshotHash: row.reviewed_evidence_snapshot_hash ?? null,
    reviewer: row.reviewer ?? null,
    reviewedAt: row.reviewed_at ?? null,
    rowVersion: row.row_version,
    proposalRelativePath: row.proposal_relative_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function wikiReviewIndex() {
  const markdownIndex = wikiMarkdownIndex() as {
    documents: Row[];
    latestScan: Row | null;
  };
  const proposals = latestProposals();
  const documents: WikiReviewIndexItem[] = await Promise.all(markdownIndex.documents.map(async (document) => {
    let currentByteHash: string | null = document.byteHash ?? null;
    let indexStale = document.parseStatus !== 'valid';
    if (document.parseStatus === 'valid') {
      try {
        const detail = await wikiMarkdownDetail(document.docId) as Row;
        currentByteHash = detail.currentByteHash ?? document.byteHash ?? null;
        indexStale = Boolean(detail.indexStale);
      } catch {
        currentByteHash = null;
        indexStale = true;
      }
    }
    const proposal = proposals.get(document.docId);
    const status = deriveWikiReviewStatus({
      latestScanStatus: markdownIndex.latestScan?.status,
      parseStatus: document.parseStatus,
      indexStale,
      currentByteHash,
      proposalStatus: proposal?.status,
      reviewedBaseByteHash: proposal?.reviewed_base_byte_hash,
      targetByteHash: proposal?.target_byte_hash,
    });
    return {
      ...document,
      currentByteHash,
      indexedByteHash: document.byteHash ?? null,
      indexStale,
      status,
      statusLabel: wikiReviewStatusMeta[status].label,
      statusTone: wikiReviewStatusMeta[status].tone,
      latestProposal: proposalSummary(proposal),
    } as WikiReviewIndexItem;
  }));
  const counts = Object.fromEntries(
    Object.keys(wikiReviewStatusMeta).map((status) => [
      status,
      documents.filter((document) => document.status === status).length,
    ]),
  );
  return { documents, latestScan: markdownIndex.latestScan, counts };
}

function entitySnapshot(db: DatabaseSync, document: Row) {
  const tables: Record<string, string> = {
    matter: 'matter',
    organization: 'organization',
    person: 'person',
    group: 'matter_group',
  };
  const entityType = String(document.entity_type ?? '');
  const entityId = String(document.entity_id ?? '');
  const table = tables[entityType];
  if (!table || !entityId) return null;
  const entity = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(entityId) as Row | undefined;
  if (!entity) return null;
  const matterIds = entityType === 'matter'
    ? [entityId]
    : entityType === 'group'
      ? (db.prepare('SELECT matter_id FROM matter_group_member WHERE group_id=? ORDER BY matter_id').all(entityId) as Row[]).map((row) => row.matter_id)
      : (db.prepare('SELECT DISTINCT matter_id FROM matter_party WHERE party_type=? AND party_id=? ORDER BY matter_id').all(entityType, entityId) as Row[]).map((row) => row.matter_id);
  const matters = matterIds
    .map((id) => db.prepare('SELECT * FROM matter WHERE id=?').get(id) as Row | undefined)
    .filter(Boolean);
  const works = matterIds.flatMap((id) => db.prepare('SELECT * FROM work_item WHERE matter_id=? AND archived_at IS NULL ORDER BY id').all(id) as Row[]);
  const actions = matterIds.flatMap((id) => db.prepare('SELECT * FROM action_item WHERE matter_id=? AND archived_at IS NULL ORDER BY id').all(id) as Row[]);
  return { entityType, entityId, entity, matters, works, actions };
}

function latestProposalDetail(db: DatabaseSync, docId: string) {
  const proposal = proposalRows(db).find((row) => row.doc_id === docId);
  if (!proposal) return null;
  return {
    ...proposalSummary(proposal),
    operation: db.prepare('SELECT * FROM wiki_file_operation WHERE id=?').get(proposal.operation_id) ?? null,
    evidence: db.prepare(`
      SELECT
        block_id AS blockId,
        sentence_hash AS sentenceHash,
        source_kind AS sourceKind,
        source_id AS sourceId,
        source_hash AS sourceHash,
        validation_status AS validationStatus,
        checked_at AS checkedAt
      FROM wiki_proposal_evidence
      WHERE proposal_id=?
      ORDER BY block_id,source_kind,source_id
    `).all(proposal.id),
    reviews: db.prepare(`
      SELECT
        action,reviewer,
        reviewed_base_byte_hash AS reviewedBaseByteHash,
        reviewed_evidence_snapshot_hash AS reviewedEvidenceSnapshotHash,
        review_event_id AS reviewEventId,
        created_at AS createdAt
      FROM wiki_proposal_review
      WHERE proposal_id=?
      ORDER BY created_at DESC,id DESC
    `).all(proposal.id),
  };
}

export async function wikiReviewDocument(docId: string) {
  const index = await wikiReviewIndex();
  const item = index.documents.find((document) => document.docId === docId);
  if (!item) throw new WorkDbError('Wiki 검토 문서를 찾을 수 없습니다.', 404, 'WIKI_REVIEW_NOT_FOUND');
  let source: Row | null = null;
  try {
    source = await wikiMarkdownDetail(docId) as Row;
  } catch {
    source = null;
  }
  const database = withDatabase((db) => {
    const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(docId) as Row | undefined;
    if (!document) throw new WorkDbError('Wiki 검토 문서를 찾을 수 없습니다.', 404, 'WIKI_REVIEW_NOT_FOUND');
    return {
      snapshot: entitySnapshot(db, document),
      proposal: latestProposalDetail(db, docId),
    };
  });
  return {
    item,
    source,
    database: database.snapshot,
    proposal: database.proposal,
    latestScan: index.latestScan,
  };
}
