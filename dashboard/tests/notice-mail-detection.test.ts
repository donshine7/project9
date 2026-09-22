import assert from 'node:assert/strict';
import { detectNoticeMail, type NoticeMailInput } from '../lib/notice-mail-detection';

const base: NoticeMailInput = {
  direction: 'received',
  folderPath: '/jtjang@sspat.net/국내특허 OA/ 우선심사 보완',
  storeDisplayName: 'jtjang@sspat.net',
  recipients: [{ type: 'to', displayName: '장진태', smtpAddress: 'jtjang@sspat.net', resolved: true }],
  mailAt: '2026-09-21T00:00:00.000Z',
};

const cases = [
  { subject: '[업무요청]의견제출통지서 대응 [P261487/주식회사 홈런코퍼레이션]', kind: 'opinion_submission' },
  { subject: '[업무요청] 거절결정서 접수 [P261487/주식회사 홈런코퍼레이션]', kind: 'rejection_decision' },
  { subject: '[업무요청] 우선심사신청보완요구서 대응 [P261643/효성프라콘 주식회사]', kind: 'priority_exam_supplement_request' },
] as const;

for (const [index, item] of cases.entries()) {
  const detected = detectNoticeMail({ ...base, subject: item.subject, body: '대응기한: 2027.01.21', internetMessageId: `<request-${index}@sspat.net>` });
  assert.equal(detected?.noticeKind, item.kind);
  assert.equal(detected?.mailRole, 'work_request');
  assert.equal(detected?.dueDate, '2027-01-21');
  assert.equal(detected?.recipientMatchMethod, 'smtp');
}

const assignment = detectNoticeMail({
  ...base,
  subject: '[EASYPAT_S] [P261643][효성프라콘 주식회사] 건의 업무담당자로 지정되었습니다.',
  body: '- OurRef : P261643\n- 담당자업무 : 우선심사신청보완요구서',
  entryId: 'assignment-1',
});
assert.equal(assignment?.noticeKind, 'priority_exam_supplement_request');
assert.equal(assignment?.mailRole, 'assignment');

assert.equal(detectNoticeMail({ ...base, subject: cases[0].subject, body: '', recipients: [{ type: 'cc', displayName: '장진태', smtpAddress: 'jtjang@sspat.net' }] }), null);
assert.equal(detectNoticeMail({ ...base, subject: cases[0].subject, body: '', recipients: [{ type: 'to', displayName: '국내관리팀', smtpAddress: 'domestic@sspat.net' }] }), null);
assert.equal(detectNoticeMail({ ...base, subject: cases[0].subject, body: '', recipients: [{ type: 'to', displayName: '장진태', smtpAddress: null }] })?.recipientMatchMethod, 'display_name_fallback');
assert.equal(detectNoticeMail({ ...base, subject: cases[0].subject, body: '', storeDisplayName: 'other@sspat.net', recipients: [{ type: 'to', displayName: '장진태', smtpAddress: null }] }), null);
assert.equal(detectNoticeMail({ ...base, subject: `RE: ${cases[0].subject}`, body: '장진태\n대응기한: 2027.01.21' }), null);
assert.equal(detectNoticeMail({ ...base, subject: '[업무요청]의견제출통지서 대응 [P261487/회사]', body: '현재 P261610도 검토\n-----Original Message-----\n[P261487]' }), null);
assert.equal(detectNoticeMail({ ...base, direction: 'sent', subject: cases[0].subject, body: '' }), null);
assert.equal(detectNoticeMail({ ...base, folderPath: '/jtjang@sspat.net/받은 편지함', subject: cases[0].subject, body: '' }), null);

const suffix = detectNoticeMail({ ...base, subject: '[업무요청]의견제출통지서 대응 [P261487-CN(PA)/회사]', body: '', entryId: 'suffix' });
assert.equal(suffix?.matterReference, 'P261487-CN(PA)');

console.log('Notice mail recipient and template detection tests passed.');
