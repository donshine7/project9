'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { readApiObject } from '../../lib/api-response';
import {
  Button,
  DocumentListItem,
  type ReviewStatus,
  StatusBadge,
  Tab,
} from './components';
import { wikiApprovalAdapter } from './review-adapter';
import { wikiOperationView } from './operation-model';
import { DocumentApprovalPanel, ReviewStatePanel, WikiOperationStateCard, WorkStateBoundary } from './review-panels';
import { displayStatus, displayStatusMeta, matchesReviewFilter, type ApprovalAction, type DocumentApproval, type ReviewStateInput } from './review-model';

type Row = Record<string, any>;
type ReviewDocument = {
  docId: string;
  title: string;
  documentType: string;
  entityType?: string | null;
  entityId?: string | null;
  relativePath: string;
  parseStatus: string;
  currentByteHash?: string | null;
  indexedByteHash?: string | null;
  indexStale: boolean;
  status: ReviewStatus;
  statusLabel: string;
  updatedAt: string;
  latestProposal?: Row | null;
  documentApproval?: DocumentApproval | null;
};

type ReviewIndex = {
  documents: ReviewDocument[];
  latestScan: Row | null;
  counts: Record<string, number>;
};

type ReviewDetail = {
  item: ReviewDocument;
  source: Row | null;
  database: Row | null;
  proposal: Row | null;
  latestScan: Row | null;
  recovery?: { status: string } | null;
};

async function request(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  return readApiObject(response);
}

function post(url: string, body?: unknown) {
  return request(url, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function shortHash(value?: string | null) {
  return value ? `sha256:${value.slice(0, 8)}…${value.slice(-4)}` : '없음';
}

function formatTime(value?: string | null) {
  if (!value) return '기록 없음';
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function proposalStatusLabel(status?: string) {
  const labels: Record<string, string> = {
    prepared: '파일 작성 준비',
    ready_for_review: '검토 대기',
    reviewed: '수동 반영 검토 완료',
    rejected: '반려',
    stale_document: '문서 변경',
    stale_evidence: '근거 변경',
    applied_observed: '수동 반영 확인',
    failed: '실패',
  };
  return status ? labels[status] ?? status : '제안 없음';
}

function reviewState(document: ReviewDocument, proposalStatus?: string | null, proposalUpdatedAt?: string | null, recoveryStatus?: string | null): ReviewStateInput {
  return {
    status: document.status,
    currentByteHash: document.currentByteHash,
    indexedByteHash: document.indexedByteHash,
    indexStale: document.indexStale,
    parseStatus: document.parseStatus,
    documentApproval: document.documentApproval,
    proposalStatus,
    proposalUpdatedAt,
    recoveryStatus,
  };
}

export default function WikiPage() {
  const [index, setIndex] = useState<ReviewIndex>({ documents: [], latestScan: null, counts: {} });
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [approvalAction, setApprovalAction] = useState<ApprovalAction | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'review' | 'issues'>('all');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const loadIndex = useCallback(async () => {
    const data = await request('/api/wiki-review') as ReviewIndex;
    setIndex(data);
    return data.documents;
  }, []);

  const loadDetail = useCallback(async (docId: string) => {
    const data = await request(`/api/wiki-review/documents/${encodeURIComponent(docId)}`) as ReviewDetail;
    return data;
  }, []);

  useEffect(() => {
    loadIndex()
      .then((documents) => setSelected((current) => current || documents[0]?.docId || ''))
      .catch((error) => setNotice(error instanceof Error ? error.message : 'Wiki 목록을 불러오지 못했습니다.'));
  }, [loadIndex]);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setApprovalAction(null);
    Promise.all([loadDetail(selected), wikiApprovalAdapter.preflight(selected)])
      .then(([document, action]) => {
        if (!cancelled) {
          setDetail(document);
          setApprovalAction(action);
        }
      })
      .catch((error) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : 'Wiki 문서를 불러오지 못했습니다.');
      });
    return () => { cancelled = true; };
  }, [loadDetail, selected]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ko-KR');
    return index.documents.filter((document) => {
      const matchesQuery = !normalized
        || document.title.toLocaleLowerCase('ko-KR').includes(normalized)
        || document.docId.toLocaleLowerCase('ko-KR').includes(normalized)
        || document.relativePath.toLocaleLowerCase('ko-KR').includes(normalized);
      const matchesFilter = matchesReviewFilter(
        displayStatus(reviewState(document, document.latestProposal?.status, document.latestProposal?.updatedAt)), filter,
      );
      return matchesQuery && matchesFilter;
    });
  }, [filter, index.documents, query]);

  async function perform(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice('');
    try {
      await action();
      const documents = await loadIndex();
      if (selected && documents.some((document) => document.docId === selected)) {
        const [document, approval] = await Promise.all([loadDetail(selected), wikiApprovalAdapter.preflight(selected)]);
        setDetail(document);
        setApprovalAction(approval);
      }
      setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '작업을 완료하지 못했습니다.');
      if (selected) {
        try {
          const [document, approval] = await Promise.all([loadDetail(selected), wikiApprovalAdapter.preflight(selected)]);
          setDetail(document);
          setApprovalAction(approval);
        } catch { /* Preserve the action error. */ }
      }
    } finally {
      setBusy(false);
    }
  }

  const proposal = detail?.proposal;
  const database = detail?.database;
  const source = detail?.source;
  const reviewInput = detail
    ? reviewState(detail.item, detail.proposal?.status, detail.proposal?.updatedAt, detail.recovery?.status)
    : null;
  const operationView = detail ? wikiOperationView(detail.proposal, detail.item.currentByteHash) : null;

  return (
    <div className="wiki-review-shell">
      <header className="wiki-review-header">
        <div className="wiki-review-brand">
          <a href="/matters">상상 업무자동화</a>
          <span>업무 Wiki 검토</span>
        </div>
        <div className="wiki-review-header-actions">
          <span className="wiki-review-environment">MARKDOWN FIRST · HUMAN GATE</span>
          <Button
            disabled={busy}
            onClick={() => perform(() => post('/api/wiki-markdown/scans'), 'Wiki Vault를 다시 색인했습니다.')}
          >
            인덱스 갱신
          </Button>
        </div>
      </header>

      {notice && <p className="wiki-review-notice" role="status">{notice}</p>}

      <main className="wiki-review-grid">
        <aside className="wiki-review-panel wiki-review-sidebar" aria-label="Wiki 문서 목록">
          <div className="wiki-review-panel-heading">
            <div>
              <h1>문서</h1>
              <p>{index.documents.length}개 · {index.latestScan ? formatTime(index.latestScan.completedAt ?? index.latestScan.startedAt) : '아직 색인하지 않음'}</p>
            </div>
            {index.latestScan?.status === 'running' && <StatusBadge status="indexing" />}
          </div>

          <label className="wiki-review-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="문서 ID·제목·경로 검색"
              aria-label="Wiki 문서 검색"
            />
          </label>

          <div className="wiki-review-tabs" aria-label="문서 상태 필터">
            <Tab active={filter === 'all'} onClick={() => setFilter('all')}>전체</Tab>
            <Tab active={filter === 'review'} onClick={() => setFilter('review')}>검토</Tab>
            <Tab active={filter === 'issues'} onClick={() => setFilter('issues')}>오류</Tab>
          </div>

          <div className="wiki-review-document-list">
            {filtered.map((document) => {
              const status = displayStatus(reviewState(document, document.latestProposal?.status, document.latestProposal?.updatedAt));
              return (
                <DocumentListItem
                  key={document.docId}
                  active={document.docId === selected}
                  warning={['missing', 'duplicate_id', 'conflict', 'evidence_stale'].includes(status)}
                  documentTitle={document.title}
                  meta={document.relativePath}
                  status={document.status}
                  statusLabel={displayStatusMeta[status].label}
                  onClick={() => setSelected(document.docId)}
                />
              );
            })}
            {!filtered.length && (
              <p className="wiki-review-empty">
                조건에 맞는 문서가 없습니다. Vault를 색인하거나 필터를 변경하세요.
              </p>
            )}
          </div>
        </aside>

        <section className="wiki-review-panel wiki-review-main" aria-label="Wiki 문서 검토">
          {!selected && <p className="wiki-review-empty">왼쪽에서 문서를 선택하세요.</p>}
          {selected && !detail && <p className="wiki-review-empty">문서 상태를 불러오는 중입니다.</p>}
          {detail && (
            <>
              <div className="wiki-review-title-row">
                <div>
                  <h2>{detail.item.title}</h2>
                  <p>{detail.item.relativePath} · {detail.item.entityType ?? detail.item.documentType}</p>
                </div>
                <StatusBadge status={detail.item.status} label={reviewInput ? displayStatusMeta[displayStatus(reviewInput)].label : undefined} />
              </div>

              <section className="wiki-review-comparison" aria-label="Markdown과 DB 비교">
                <article className="wiki-review-source-card is-markdown">
                  <h3>Markdown 최신 파일</h3>
                  <dl>
                    <div><dt>수정</dt><dd>{formatTime(detail.item.updatedAt)}</dd></div>
                    <div><dt>현재 hash</dt><dd>{shortHash(detail.item.currentByteHash)}</dd></div>
                    <div><dt>색인 hash</dt><dd>{shortHash(detail.item.indexedByteHash)}</dd></div>
                    <div><dt>경로</dt><dd>{detail.item.relativePath}</dd></div>
                  </dl>
                </article>
                <article className="wiki-review-source-card">
                  <h3>DB 현재 상태</h3>
                  {database?.entity ? (
                    <dl>
                      <div><dt>식별자</dt><dd>{database.entity.our_ref ?? database.entity.name ?? database.entityId}</dd></div>
                      <div><dt>업무</dt><dd>{database.works?.length ?? 0}건</dd></div>
                      <div><dt>Action</dt><dd>{database.actions?.length ?? 0}건</dd></div>
                      <div><dt>갱신</dt><dd>{formatTime(database.entity.updated_at)}</dd></div>
                    </dl>
                  ) : <p>연결된 업무 엔터티가 없는 지식·노트 문서입니다.</p>}
                </article>
              </section>

              {reviewInput && <ReviewStatePanel input={reviewInput} />}
              {operationView && <WikiOperationStateCard view={operationView} />}
              <WorkStateBoundary />
              {reviewInput && (
                <DocumentApprovalPanel
                  key={`${detail.item.docId}:${detail.item.currentByteHash}:${approvalAction?.expectedEvidenceSnapshotHash}:${approvalAction?.code}`}
                  input={reviewInput}
                  action={approvalAction}
                  busy={busy}
                  onApprove={(action) => perform(
                    () => wikiApprovalAdapter.approve(detail.item.docId, action),
                    '현재 Markdown 원문 승인 상태를 확인했습니다. 업무 상태는 변경되지 않았습니다.',
                  )}
                />
              )}

              <section className="wiki-review-proposal">
                <div className="wiki-review-section-heading">
                  <div>
                    <h3>변경 제안</h3>
                    <p>AI 제안 검토는 문서 원문 승인 및 업무 상태 변경과 별도입니다.</p>
                  </div>
                  <span className="wiki-review-proposal-status">{proposalStatusLabel(proposal?.status)}</span>
                </div>
                {proposal ? (
                  <>
                    <p className="wiki-review-change-summary">{proposal.changeSummary}</p>
                    <dl className="wiki-review-proposal-hashes">
                      <div><dt>기준</dt><dd>{shortHash(proposal.baseByteHash)}</dd></div>
                      <div><dt>목표</dt><dd>{shortHash(proposal.targetByteHash)}</dd></div>
                      <div><dt>검토자</dt><dd>{proposal.reviewer ?? '미검토'}</dd></div>
                    </dl>
                  </>
                ) : (
                  <p className="wiki-review-empty">이 문서에 생성된 제안이 없습니다.</p>
                )}
              </section>

              <details className="wiki-review-markdown-panel">
                <summary>Markdown 본문 보기</summary>
                <pre>{source?.markdown ?? '유효한 Markdown 원본을 읽을 수 없습니다.'}</pre>
              </details>

              <div className="wiki-review-actions">
                <Button
                  disabled={busy}
                  onClick={async () => {
                    await navigator.clipboard.writeText(detail.item.relativePath);
                    setNotice('Obsidian Vault 상대 경로를 복사했습니다.');
                  }}
                >
                  경로 복사
                </Button>
                <Button
                  disabled={busy || detail.item.parseStatus !== 'valid'}
                  onClick={() => perform(
                    () => post(`/api/wiki-markdown/documents/${encodeURIComponent(detail.item.docId)}/proposals/prepare`),
                    '제안 실행을 준비했습니다. 생성된 실행 패킷으로 Wiki 제안을 수행하세요.',
                  )}
                >
                  제안 준비
                </Button>
                {proposal?.status === 'ready_for_review' && (
                  <>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => perform(
                        () => post(`/api/wiki-markdown/proposals/${encodeURIComponent(proposal.id)}/reviews`, {
                          action: 'reject',
                          expectedVersion: proposal.rowVersion,
                          reviewer: '장진태',
                        }),
                        '제안을 반려했습니다.',
                      )}
                    >
                      반려
                    </Button>
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => perform(
                        () => post(`/api/wiki-markdown/proposals/${encodeURIComponent(proposal.id)}/reviews`, {
                          action: 'accept_for_manual_apply',
                          expectedVersion: proposal.rowVersion,
                          reviewer: '장진태',
                        }),
                        '수동 반영 대상으로 승인했습니다. 활성 Markdown은 변경되지 않았습니다.',
                      )}
                    >
                      AI 제안 수동 반영 검토
                    </Button>
                  </>
                )}
                {proposal && (
                  <Button
                    disabled={busy}
                    onClick={() => perform(
                      () => post(`/api/wiki-markdown/proposals/${encodeURIComponent(proposal.id)}/reconcile`),
                      '현재 파일·근거와 제안 상태를 다시 대조했습니다.',
                    )}
                  >
                    상태 대조
                  </Button>
                )}
              </div>
            </>
          )}
        </section>

        <aside className="wiki-review-panel wiki-review-evidence" aria-label="근거와 검토 이력">
          <div className="wiki-review-panel-heading">
            <div>
              <h2>근거</h2>
              <p>{proposal?.evidence?.length ?? 0}건</p>
            </div>
            {proposal && (
              <StatusBadge status={proposal.status === 'stale_evidence' ? 'evidence_stale' : 'up_to_date'} />
            )}
          </div>

          <section className="wiki-review-provenance">
            <h3>근거 스냅샷</h3>
            <p>{proposal ? shortHash(proposal.evidenceSnapshotHash) : '제안 생성 전'}</p>
            <p>인덱스: {formatTime(detail?.latestScan?.completedAt ?? detail?.latestScan?.startedAt)}</p>
          </section>

          <div className="wiki-review-evidence-list">
            {(proposal?.evidence ?? []).map((evidence: Row) => (
              <article
                className={`wiki-review-evidence-card ${evidence.validationStatus === 'valid' ? '' : 'is-warning'}`}
                key={`${evidence.blockId}-${evidence.sourceKind}-${evidence.sourceId}`}
              >
                <div>
                  <strong>{evidence.sourceId}</strong>
                  <StatusBadge status={evidence.validationStatus === 'valid' ? 'up_to_date' : 'evidence_stale'} />
                </div>
                <p>{evidence.blockId}</p>
                <span>{evidence.sourceKind} · {formatTime(evidence.checkedAt)}</span>
              </article>
            ))}
            {!proposal?.evidence?.length && (
              <p className="wiki-review-empty">제안이 만들어지면 문장별 근거가 여기에 표시됩니다.</p>
            )}
          </div>

          <section className="wiki-review-human-gate">
            <h3>Human gate</h3>
            <p>AI 제안 검토만으로 Markdown 원문은 승인되지 않고, 사건의 업무 단계와 Action도 변경되지 않습니다.</p>
          </section>
        </aside>
      </main>
    </div>
  );
}
