import { createHash } from 'node:crypto';
import { matterReferenceTokens, parseMatterNumber } from './matter-number';

export type NoticeMailKind = 'opinion_submission' | 'rejection_decision' | 'priority_exam_supplement_request';
export type NoticeMailRole = 'work_request' | 'assignment';
export type RecipientSnapshot = { type?: string; displayName?: string | null; smtpAddress?: string | null; resolved?: boolean };
export type NoticeMailInput = {
  subject?: string | null;
  body?: string | null;
  direction?: string | null;
  folderPath?: string | null;
  storeDisplayName?: string | null;
  recipients?: RecipientSnapshot[] | null;
  recipientSnapshotHash?: string | null;
  internetMessageId?: string | null;
  entryId?: string | null;
  mailAt?: string | null;
};

export type NoticeMailCandidate = {
  matterReference: string;
  noticeKind: NoticeMailKind;
  mailRole: NoticeMailRole;
  dueDate: string | null;
  recipientMatchMethod: 'smtp' | 'display_name_fallback';
  stableMailKey: string;
  evidence: { parserVersion: string; subjectHash: string; currentBodyHash: string; recipientSnapshotHash: string | null };
};

const TARGET_STORE = 'jtjang@sspat.net';
const PARSER_VERSION = 'notice-mail-v1';

function normalizedSpace(value: unknown) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function currentMessageBody(value: unknown) {
  const body = String(value ?? '');
  const boundaries = [/^\s*-{2,}\s*(?:Original Message|원본 메시지)\s*-{2,}\s*$/imu, /^\s*(?:From|보낸 사람)\s*:/imu];
  let end = body.length;
  for (const boundary of boundaries) {
    const match = boundary.exec(body);
    if (match && match.index < end) end = match.index;
  }
  return body.slice(0, end);
}

function isoDate(value: string) {
  const match = /^(\d{4})[-.](\d{2})[-.](\d{2})$/.exec(value.trim());
  if (!match) return null;
  const result = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${result}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === result ? result : null;
}

function directRecipient(input: NoticeMailInput) {
  if (normalizedSpace(input.storeDisplayName).toLowerCase() !== TARGET_STORE) return null;
  const recipients = Array.isArray(input.recipients) ? input.recipients : [];
  for (const recipient of recipients) {
    if (String(recipient?.type ?? '').toLowerCase() !== 'to') continue;
    const smtp = normalizedSpace(recipient.smtpAddress).toLowerCase();
    if (smtp === TARGET_STORE) return 'smtp' as const;
    if (!smtp && normalizedSpace(recipient.displayName) === '장진태') return 'display_name_fallback' as const;
  }
  return null;
}

function noticeKindFromWorkRequest(subject: string): NoticeMailKind | null {
  if (!/^\[업무요청\]\s*/u.test(subject)) return null;
  const prefix = subject.slice(0, subject.indexOf('[' , 1) >= 0 ? subject.indexOf('[', 1) : subject.length).replace(/\s+/g, '');
  if (/^\[업무요청\]의견제출통지서(?:대응|대응요청)$/u.test(prefix)) return 'opinion_submission';
  if (/^\[업무요청\]거절결정서(?:대응|대응요청|접수)$/u.test(prefix)) return 'rejection_decision';
  if (/^\[업무요청\]우선심사신청보완요구서(?:대응|대응요청)$/u.test(prefix)) return 'priority_exam_supplement_request';
  return null;
}

function noticeKindFromAssignment(body: string): NoticeMailKind | null {
  const match = /(?:업무내용|담당자업무)\s*:\s*([^\r\n]+)/u.exec(body);
  if (!match) return null;
  const value = normalizedSpace(match[1]);
  if (value === '의견제출통지서') return 'opinion_submission';
  if (value === '거절결정서') return 'rejection_decision';
  if (value === '우선심사신청보완요구서') return 'priority_exam_supplement_request';
  return null;
}

function stableMailKey(input: NoticeMailInput, subject: string, body: string) {
  for (const value of [input.internetMessageId, input.entryId]) {
    const normalized = normalizedSpace(value).toLowerCase();
    if (normalized) return normalized;
  }
  return `hash:${createHash('sha256').update(JSON.stringify([subject, input.mailAt ?? '', body])).digest('hex')}`;
}

export function detectNoticeMail(input: NoticeMailInput): NoticeMailCandidate | null {
  if (String(input.direction ?? '').toLowerCase() !== 'received') return null;
  if (!/국내특허\s*OA[\\/]+\s*우선심사\s*보완/iu.test(String(input.folderPath ?? ''))) return null;
  const recipientMatchMethod = directRecipient(input);
  if (!recipientMatchMethod) return null;

  const subject = normalizedSpace(input.subject), body = currentMessageBody(input.body);
  let noticeKind: NoticeMailKind | null = null, mailRole: NoticeMailRole | null = null;
  if (subject.startsWith('[업무요청]')) {
    noticeKind = noticeKindFromWorkRequest(subject);
    mailRole = noticeKind ? 'work_request' : null;
  } else if (/^\[EASYPAT_S\]\s*\[[^\]]+\].*업무담당자로\s*지정되었습니다\.?$/u.test(subject)) {
    noticeKind = noticeKindFromAssignment(body);
    mailRole = noticeKind ? 'assignment' : null;
  }
  if (!noticeKind || !mailRole) return null;

  const references = matterReferenceTokens(`${subject}\n${body}`);
  if (references.length !== 1) return null;
  let matterReference: string;
  try { matterReference = parseMatterNumber(references[0]).normalized; } catch { return null; }
  if (!/^P\d{6}(?:-[A-Z0-9]+|\([A-Z0-9-]+\))*$/u.test(matterReference)) return null;
  if (mailRole === 'assignment') {
    const ourRef = /OurRef\s*:\s*([^\s\r\n]+)/iu.exec(body)?.[1];
    if (!ourRef || normalizedSpace(ourRef).toUpperCase() !== matterReference) return null;
  }
  const dueRaw = /대응기한\s*:\s*(\d{4}[-.]\d{2}[-.]\d{2})/u.exec(body)?.[1];
  const dueDate = dueRaw ? isoDate(dueRaw) : null;
  return {
    matterReference,
    noticeKind,
    mailRole,
    dueDate,
    recipientMatchMethod,
    stableMailKey: stableMailKey(input, subject, body),
    evidence: {
      parserVersion: PARSER_VERSION,
      subjectHash: createHash('sha256').update(subject).digest('hex'),
      currentBodyHash: createHash('sha256').update(body).digest('hex'),
      recipientSnapshotHash: input.recipientSnapshotHash ?? null,
    },
  };
}
