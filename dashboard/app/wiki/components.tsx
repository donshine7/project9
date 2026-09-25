import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ReviewStatus =
  | 'reviewed'
  | 'needs_review'
  | 'evidence_stale'
  | 'missing'
  | 'duplicate_id'
  | 'conflict'
  | 'indexing'
  | 'up_to_date';

const statusLabels: Record<ReviewStatus, string> = {
  reviewed: '검토 완료',
  needs_review: '검토 필요',
  evidence_stale: '근거 변경',
  missing: '파일 누락',
  duplicate_id: 'ID 중복',
  conflict: '충돌',
  indexing: '인덱싱 중',
  up_to_date: '최신',
};

export function StatusBadge({ status, label }: { status: ReviewStatus; label?: string }) {
  return (
    <span className={`wiki-review-badge is-${status}`}>
      <span aria-hidden="true" className="wiki-review-badge-dot" />
      {label ?? statusLabels[status]}
    </span>
  );
}

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
}) {
  return <button type={type} className={`wiki-review-button is-${variant} ${className}`.trim()} {...props} />;
}

export function Tab({
  active,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { active: boolean; children: ReactNode }) {
  return (
    <button type="button" className={`wiki-review-tab ${active ? 'is-active' : ''}`} aria-pressed={active} {...props}>
      {children}
    </button>
  );
}

export function DocumentListItem({
  active,
  warning,
  documentTitle,
  meta,
  status,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  warning?: boolean;
  documentTitle: string;
  meta: string;
  status?: ReviewStatus;
}) {
  return (
    <button
      type="button"
      className={`wiki-review-document ${active ? 'is-selected' : ''} ${warning ? 'is-warning' : ''}`.trim()}
      aria-current={active ? 'page' : undefined}
      {...props}
    >
      <span className="wiki-review-document-type">WIKI DOCUMENT</span>
      <span className="wiki-review-document-title">{documentTitle}</span>
      <span className="wiki-review-document-meta">{meta}</span>
      {status && <StatusBadge status={status} />}
    </button>
  );
}
