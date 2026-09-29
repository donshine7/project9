import { useState } from 'react';
import { Button } from './components';
import {
  approvalBlockReason,
  displayStatus,
  displayStatusMeta,
  type ApprovalAction,
  type ReviewStateInput,
} from './review-model';
import styles from './review-panels.module.css';
import type { WikiOperationView } from './operation-model';

function shortHash(value?: string | null) {
  return value ? `sha256:${value.slice(0, 8)}…${value.slice(-4)}` : '없음';
}

export function ReviewStatePanel({ input }: { input: ReviewStateInput }) {
  const status = displayStatus(input);
  const meta = displayStatusMeta[status];
  return (
    <section className={`${styles.state} ${styles[status]}`} aria-label="Wiki 검토 상태" data-review-status={status}>
      <div className={styles.stateHeading}>
        <span className={styles.status}>{meta.label}</span>
        <h3>{meta.heading}</h3>
      </div>
      <p>{meta.guidance}</p>
      <dl className={styles.hashes}>
        <div><dt>현재 파일</dt><dd>{shortHash(input.currentByteHash)}</dd></div>
        <div><dt>색인 기준</dt><dd>{shortHash(input.indexedByteHash)}</dd></div>
        {input.documentApproval && (
          <div><dt>승인된 파일</dt><dd>{shortHash(input.documentApproval.byteHash)}</dd></div>
        )}
      </dl>
      {status === 'approved' && input.documentApproval && (
        <p className={styles.audit}>승인자 {input.documentApproval.reviewer} · 승인 이벤트 {input.documentApproval.eventId}</p>
      )}
    </section>
  );
}

export function DocumentApprovalPanel({
  input,
  action,
  busy,
  onApprove,
}: {
  input: ReviewStateInput;
  action?: ApprovalAction | null;
  busy: boolean;
  onApprove: (action: ApprovalAction) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const reason = approvalBlockReason(input, action);
  return (
    <section className={styles.approval} aria-label="문서 원문 승인">
      <div>
        <h3>현재 문서 원문 승인</h3>
        <p>현재 Markdown 파일의 정확한 개정과 근거 스냅샷을 승인 이력에 기록합니다. 이 작업은 업무 단계·Action을 변경하지 않습니다.</p>
      </div>
      {reason ? (
        <p className={styles.blockReason} role="status">{reason}</p>
      ) : (
        <>
          <dl className={styles.hashes}>
            <div><dt>승인 대상</dt><dd>{shortHash(action?.expectedByteHash)}</dd></div>
            <div><dt>근거</dt><dd>{shortHash(action?.expectedEvidenceSnapshotHash)}</dd></div>
          </dl>
          <label className={styles.confirmation}>
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>현재 Markdown 원문과 근거를 직접 확인했습니다.</span>
          </label>
        </>
      )}
      <Button
        variant="primary"
        disabled={busy || Boolean(reason) || !confirmed}
        onClick={() => { if (action && !reason && confirmed) void onApprove(action).finally(() => setConfirmed(false)); }}
      >
        문서 원문 승인 기록
      </Button>
    </section>
  );
}

export function WorkStateBoundary() {
  return (
    <section className={styles.boundary} aria-label="문서와 업무 상태 구분">
      <h3>업무 상태는 별도 기록</h3>
      <p>문서 승인과 AI 제안 검토는 Wiki 이력입니다. 사건의 업무종류, 단계, 현재상태, Action은 이 화면의 승인으로 변경되지 않습니다.</p>
    </section>
  );
}

export function WikiOperationStateCard({ view }: { view: WikiOperationView }) {
  return (
    <section
      className={`${styles.operation} ${styles[`operation_${view.tone}`]}`}
      aria-label="Wiki 자동 반영 작업 상태"
      data-operation-state={view.state}
    >
      <div className={styles.stateHeading}>
        <span className={styles.status}>{view.label}</span>
        <h3>자동 반영 작업</h3>
      </div>
      <p><strong>이유</strong> · {view.reason}</p>
      <p><strong>다음 행동</strong> · {view.nextAction}</p>
      <p className={styles.audit}>문서 검토 상태와 별도 축으로 기록됩니다.</p>
    </section>
  );
}
