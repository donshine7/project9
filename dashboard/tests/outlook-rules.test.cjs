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

// A direct message from a confirmed overseas-management sender is enough to
// establish the overseas branch. mslee has a stronger guarantee: every direct
// message must be routed before any non-overseas rule can intercept it.
const overseasFunction = vba.slice(vba.indexOf('Private Function IsOverseasMail'), vba.indexOf('Private Function HasForeignClue'));
assert.match(overseasFunction, /If GetSenderSmtpAddress\(mail\) = "mslee@sspat\.net" _\s+Or GetSenderSmtpAddress\(mail\) = "hjlee@sspat\.net" Then\s+IsOverseasMail = True\s+Exit Function/);
assert.match(overseasFunction, /If HasOverseasMatterReference\(subjectText\) Then\s+IsOverseasMail = True\s+Exit Function/);
assert.ok(overseasFunction.indexOf('If HasOverseasMatterReference(subjectText) Then') < overseasFunction.indexOf('If hasOverseasTeam And HasForeignClue'));
const overseasReferenceFunction = vba.slice(vba.indexOf('Private Function HasOverseasMatterReference'), vba.indexOf('Private Function IsOverseasFinance'));
assert.match(overseasReferenceFunction, /\(\^\|\[\^A-Z0-9\]\)\[PTD\]\[0-9\]\{6\}/);
const countrySuffixReference = /(?:^|[^A-Z0-9])[PTD][0-9]{6}(?:-(?:S[0-9]+|DIV[0-9]+|RE))?-(?:PCT-)?(?!RE(?:[^A-Z]|$))[A-Z]{2}(?:[^A-Z]|$)/i;
const pctReference = /(?:^|[^A-Z0-9])[PTD][0-9]{6}(?:-(?:S[0-9]+|DIV[0-9]+|RE))?-PCT(?:[^A-Z]|$)/i;
const isOverseasReference = subject => countrySuffixReference.test(subject) || pctReference.test(subject);
for (const subject of [
  '[상상특허] P261937-US/주식회사 트리플닷 - 미국출원을 위한 "젤네일 제거용 화장료 조성물" 관련 명세서 초안 송부의 건',
  'P211758-PCT-EP',
  'P241750-RE-US',
  'P262000-S1-JP',
  'T261420-UA',
  'D231154-JP',
  'P261931-PCT',
]) assert.equal(isOverseasReference(subject), true, subject);
for (const subject of ['P241750-RE', 'P262000-S1', 'P241667-DIV1', 'P261937']) {
  assert.equal(isOverseasReference(subject), false, subject);
}
const destinationFunction = vba.slice(vba.indexOf('Private Function GetDestinationName'), vba.indexOf('Private Function IsOverseasMail'));
const forcedMsleeStart = destinationFunction.indexOf('If senderAddress = "mslee@sspat.net" Then');
const fixedAutomationStart = destinationFunction.indexOf("    ' 1-3. Fixed messages");
assert.ok(forcedMsleeStart >= 0 && forcedMsleeStart < fixedAutomationStart);
const forcedMsleeBlock = destinationFunction.slice(forcedMsleeStart, fixedAutomationStart);
assert.match(forcedMsleeBlock, /GetDestinationName = GetDirectOverseasDestination\(subjectText, newBody\)\s+Exit Function/);
const directDestination = destinationFunction.slice(destinationFunction.indexOf('Private Function GetDirectOverseasDestination'));
for (const folder of ['중국 가출원', '해외 견적/청구/정산', '해외 디자인', '해외 상표', '해외 특허', '해외 기타']) {
  assert.ok(directDestination.includes(`GetDirectOverseasDestination = "${folder}"`), folder);
}
for (const specificRule of ['IsOverseasFinance', 'IsOverseasDesign', 'IsOverseasTrademark', 'IsOverseasPatent']) {
  assert.ok(destinationFunction.indexOf(specificRule) < destinationFunction.lastIndexOf('GetDestinationName = "해외 기타"'));
}
function senderOnlyOverseasDestination(sender, hasSpecificOverseasClue = false) {
  const normalized = String(sender).trim().toLowerCase();
  const isOverseas = normalized === 'mslee@sspat.net' || normalized === 'hjlee@sspat.net';
  if (!isOverseas) return '';
  return hasSpecificOverseasClue ? '해외 세부분류' : '해외 기타';
}
assert.equal(senderOnlyOverseasDestination('mslee@sspat.net'), '해외 기타');
assert.equal(senderOnlyOverseasDestination(' MSLEE@SSPAT.NET ', true), '해외 세부분류');
assert.equal(senderOnlyOverseasDestination('hjlee@sspat.net'), '해외 기타');
assert.equal(senderOnlyOverseasDestination(' HJLEE@SSPAT.NET '), '해외 기타');
assert.equal(senderOnlyOverseasDestination('hjlee@sspat.net', true), '해외 세부분류');
assert.equal(senderOnlyOverseasDestination('other@sspat.net'), '');
assert.equal(senderOnlyOverseasDestination('hjlee@sspat.net'), '해외 기타', '[업무전달] 부재중 전화 전달의 건');

console.log('Outlook classification regression tests passed (condolence, education, domain boundary, deadline, country-suffix overseas matters, forced overseas senders, CJK encoding, event wiring).');
