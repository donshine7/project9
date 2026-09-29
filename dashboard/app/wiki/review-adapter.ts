import type { ApprovalAction } from './review-model';

type ResponseLike = Pick<Response, 'ok' | 'status' | 'json'>;
type FetchLike = (input: string, init?: RequestInit) => Promise<ResponseLike>;

export type DocumentApprovalResult = {
  eventId: string;
  docId: string;
  revisionId: string;
  byteHash: string;
  evidenceSnapshotHash: string;
  status: 'approved' | 'already_approved';
  duplicate?: boolean;
};

const statement = '현재 Markdown 원문과 근거를 직접 확인하고 이 문서 개정을 승인합니다.';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('문서 승인 API 응답 형식이 올바르지 않습니다.');
  }
  return value as Record<string, unknown>;
}

async function payload(response: ResponseLike): Promise<Record<string, unknown>> {
  try { return object(await response.json()); }
  catch { throw new Error('문서 승인 API 응답을 읽지 못했습니다.'); }
}

function failure(response: ResponseLike, data: Record<string, unknown>) {
  const code = typeof data.code === 'string' && data.code ? data.code : `HTTP_${response.status}`;
  const message = typeof data.message === 'string' && data.message
    ? data.message
    : typeof data.error === 'string' && data.error ? data.error : '문서 승인을 처리하지 못했습니다.';
  return { code, message };
}

function approvalAction(data: Record<string, unknown>): ApprovalAction {
  if (typeof data.allowed !== 'boolean'
    || typeof data.expectedRevisionId !== 'string'
    || typeof data.expectedByteHash !== 'string'
    || typeof data.expectedTextHash !== 'string'
    || typeof data.expectedEvidenceSnapshotHash !== 'string') {
    throw new Error('문서 승인 준비 응답 형식이 올바르지 않습니다.');
  }
  return {
    allowed: data.allowed,
    code: typeof data.code === 'string' ? data.code : null,
    reason: typeof data.reason === 'string' ? data.reason : null,
    expectedRevisionId: data.expectedRevisionId,
    expectedByteHash: data.expectedByteHash,
    expectedTextHash: data.expectedTextHash,
    expectedEvidenceSnapshotHash: data.expectedEvidenceSnapshotHash,
  };
}

function denied(code: string, reason: string): ApprovalAction {
  return {
    allowed: false,
    code,
    reason,
    expectedRevisionId: '',
    expectedByteHash: '',
    expectedTextHash: '',
    expectedEvidenceSnapshotHash: '',
  };
}

export function createWikiApprovalAdapter(fetcher: FetchLike, uuid: () => string) {
  const attemptKeys = new Map<string, string>();
  return {
    async preflight(docId: string): Promise<ApprovalAction | null> {
      try {
        const response = await fetcher(`/api/wiki-review/documents/${encodeURIComponent(docId)}/approvals`);
        if (response.status === 404) return null;
        const data = await payload(response);
        if (!response.ok) {
          const error = failure(response, data);
          return denied(error.code, error.message);
        }
        return approvalAction(data);
      } catch (error) {
        return denied('WIKI_PREFLIGHT_UNAVAILABLE', error instanceof Error ? error.message : '승인 가능 여부를 확인하지 못했습니다.');
      }
    },
    async approve(docId: string, action: ApprovalAction): Promise<DocumentApprovalResult> {
      const attempt = `${docId}:${action.expectedByteHash}`;
      const idempotencyKey = attemptKeys.get(attempt) ?? uuid();
      attemptKeys.set(attempt, idempotencyKey);
      let response: ResponseLike;
      try {
        response = await fetcher(`/api/wiki-review/documents/${encodeURIComponent(docId)}/approvals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedRevisionId: action.expectedRevisionId,
            expectedByteHash: action.expectedByteHash,
            expectedTextHash: action.expectedTextHash,
            expectedEvidenceSnapshotHash: action.expectedEvidenceSnapshotHash,
            idempotencyKey,
            statement,
          }),
        });
      } catch (error) {
        throw new Error(`[WIKI_APPROVAL_NETWORK_ERROR] ${error instanceof Error ? error.message : '승인 서버에 연결하지 못했습니다.'}`);
      }
      let data: Record<string, unknown>;
      try { data = await payload(response); }
      catch (error) { throw new Error(`[WIKI_APPROVAL_BAD_RESPONSE] ${error instanceof Error ? error.message : '승인 응답을 읽지 못했습니다.'}`); }
      if (!response.ok) {
        const error = failure(response, data);
        throw new Error(`[${error.code}] ${error.message}`);
      }
      if (typeof data.eventId !== 'string' || typeof data.docId !== 'string'
        || typeof data.revisionId !== 'string' || typeof data.byteHash !== 'string'
        || typeof data.evidenceSnapshotHash !== 'string'
        || !['approved', 'already_approved'].includes(String(data.status))) {
        throw new Error('[WIKI_APPROVAL_BAD_RESPONSE] 문서 승인 결과 형식이 올바르지 않습니다.');
      }
      attemptKeys.delete(attempt);
      return {
        eventId: data.eventId,
        docId: data.docId,
        revisionId: data.revisionId,
        byteHash: data.byteHash,
        evidenceSnapshotHash: data.evidenceSnapshotHash,
        status: data.status as DocumentApprovalResult['status'],
        duplicate: typeof data.duplicate === 'boolean' ? data.duplicate : undefined,
      };
    },
  };
}

export const wikiApprovalAdapter = createWikiApprovalAdapter(fetch, () => crypto.randomUUID());
