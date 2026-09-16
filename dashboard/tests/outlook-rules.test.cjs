const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function matchesConfirmedCondolenceSubject(subject) {
  const compact = String(subject).replace(/\s+/g, '');
  return compact.includes('(경조사)회원') && compact.includes('변리사');
}

const confirmedSubjects = [
  '(경조사) 회원 김성규 변리사의 모친 별세',
  '(경조사) 회원 김남명 변리사의 부친 별세',
];

for (const subject of confirmedSubjects) {
  assert.equal(matchesConfirmedCondolenceSubject(subject), true, subject);
}
assert.equal(matchesConfirmedCondolenceSubject('(안내) 회원 김남명 변리사의 부친 별세'), false);

const vba = readFileSync(path.resolve(__dirname, '..', '..', 'HiworksAutoClassifier.bas'), 'utf8');
assert.match(vba, /ContainsText\(compactSubject, "\(경조사\)회원"\)/);
assert.match(vba, /And ContainsText\(compactSubject, "변리사"\)/);
assert.match(vba, /GetDestinationName = "대한변리사회 - 경조사"/);

// Pin the exact domain expression, branch order and live event target as well
// as behavior: a correct rule in the unused HiworksRules module is ineffective.
assert.ok(vba.includes('If LCase$(Right$(Trim$(senderAddress), Len("@kpaa.or.kr"))) = "@kpaa.or.kr" Then'));
assert.ok(!vba.includes('If senderAddress = "kpaa@kpaa.or.kr" Then'));
assert.match(vba, /Attribute VB_Name = "HiworksRulesFinal"/);
const session = readFileSync(path.resolve(__dirname, '..', '..', 'ThisOutlookSession_Hiworks.txt'), 'utf8');
assert.match(session, /HiworksRulesFinal\.ClassifyIncomingMail/);
const domainBlock = vba.slice(vba.indexOf('If LCase$(Right$(Trim$(senderAddress)'), vba.indexOf("    ' 7. Deadline-list"));
assert.match(domainBlock, /If ContainsText\(subjectText, "경조사"\) Then\s+GetDestinationName = "대한변리사회 - 경조사"\s+ElseIf ContainsText\(subjectText, "연수"\) Then\s+GetDestinationName = "대한변리사회 - 교육"\s+Else\s+GetDestinationName = "대한변리사회 - 기타"/);

function kpaaDestination(sender, subject) {
  if (matchesConfirmedCondolenceSubject(subject)) return '대한변리사회 - 경조사';
  if (!sender.trim().toLowerCase().endsWith('@kpaa.or.kr')) return '';
  if (subject.includes('경조사')) return '대한변리사회 - 경조사';
  if (subject.includes('연수')) return '대한변리사회 - 교육';
  return '대한변리사회 - 기타';
}
for (const prefix of ['[안내]', '[재발송/안내]']) {
  const subject = `${prefix} 변리사 의무연수 위반 과태료 국민비서 알림서비스 이용 안내`;
  for (const sender of ['edu@kpaa.or.kr', ' EDU@KPAA.OR.KR ', 'kpaa@kpaa.or.kr']) {
    assert.equal(kpaaDestination(sender, subject), '대한변리사회 - 교육');
  }
  for (const sender of ['', 'edu@example.com', 'edu@notkpaa.or.kr', 'edu@kpaa.or.kr.example.com']) {
    assert.equal(kpaaDestination(sender, subject), '');
  }
}
assert.equal(kpaaDestination('notice@kpaa.or.kr', '일반 안내'), '대한변리사회 - 기타');
assert.equal(kpaaDestination('notice@kpaa.or.kr', '경조사 및 연수 안내'), '대한변리사회 - 경조사');
assert.equal(kpaaDestination('notice@example.com', '국민비서 과태료 안내'), '');
// Korean ANSI VBA exports cannot encode the original CJK endpoint U+9FA5.
assert.ok(vba.includes('ChrW(&H4E00) & "-" & ChrW(&H9FA5)'));
assert.ok(!vba.includes('一-龥'));
assert.match(vba, /ContainsText\(compactSubject, "\[업무전달\]"\)/);
assert.match(vba, /ContainsText\(compactSubject, "마감리스트"\)/);
assert.match(vba, /ContainsText\(compactSubject, "송부의건"\)/);
// Exercise the actual source rule's markers and destination, including a
// single-day title as well as the previously confirmed date-range title.
const deadlineBlock = vba.slice(vba.indexOf("    ' 7. Deadline-list"), vba.indexOf("    ' 8. Automatic"));
const deadlineMarkers = [...deadlineBlock.matchAll(/ContainsText\(compactSubject, "([^"]+)"\)/g)].map(match => match[1]);
assert.deepEqual(deadlineMarkers, ['[업무전달]', '마감리스트', '송부의건']);
assert.match(deadlineBlock, /Then\s+GetDestinationName = "기일관리"\s+Exit Function/);
const deadlineDestination = subject => deadlineMarkers.every(marker => String(subject).replace(/\s+/g, '').includes(marker)) ? '기일관리' : '';
for (const subject of [
  '[업무전달] 2026.09.16 마감리스트 송부의 건',
  '[업무전달] 2026.09.12 ~09.21 마감리스트 송부의 건',
  'RE: [업무전달] 2026.09.16 마감리스트 송부의 건',
  'FW: [업무전달]\t2026.09.16\u00a0마감리스트 송부의 건',
]) assert.equal(deadlineDestination(subject), '기일관리', subject);
for (const subject of [
  '2026.09.16 마감리스트 송부의 건',
  '[업무전달] 2026.09.16 마감리스트 확인 요청',
  '[업무전달] 사건등록 완료',
]) assert.equal(deadlineDestination(subject), '', subject);
console.log('Outlook classification regression tests passed (condolence, education, domain boundary, deadline, CJK encoding, event wiring).');
