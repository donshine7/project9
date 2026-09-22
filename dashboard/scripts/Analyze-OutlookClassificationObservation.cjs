const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node Analyze-OutlookClassificationObservation.cjs INPUT_JSON OUTPUT_JSON');
}
if (existsSync(outputPath)) throw new Error('Output already exists');

const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const lower = value => String(value || '').toLocaleLowerCase('ko-KR');
const contains = (source, term) => lower(source).includes(lower(term));
const containsAny = (source, terms) => terms.some(term => contains(source, term));
const compact = value => String(value || '').replace(/[\s\u00a0]+/g, '');
const sender = mail => lower(mail.senderEmail).trim();
const participants = mail => new Set([
  sender(mail),
  ...(mail.recipients || []).map(recipient => lower(recipient.address).trim()),
].filter(Boolean));

function extractNewBody(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const result = [];
  let lineNumber = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const normalized = lower(trimmed);
    if (contains(normalized, '-----original message-----')) break;
    if (trimmed === '________________________________') break;
    if (trimmed.startsWith('보낸 사람')) break;
    if (lineNumber > 2 && normalized.startsWith('from:')) break;
    if (lineNumber > 2 && normalized.startsWith('on ') && contains(normalized, ' wrote:')) break;
    if (lineNumber > 1 && [
      '--', 'best regards,', 'best regards', 'kind regards,', 'kind regards',
      'regards,', 'regards', 'sincerely,', 'sincerely', 'yours faithfully,', 'yours faithfully',
    ].includes(normalized)) break;
    result.push(line);
    lineNumber += 1;
  }
  return result.join('\n').trim();
}

const matterCode = (source, prefix) => new RegExp(`(^|[^A-Z0-9])${prefix}[0-9]{6}([^A-Z0-9]|$)`, 'i').test(String(source || ''));
const domesticSeries = source => /(^|[^A-Z0-9])P[0-9]{6}-S[0-9]+([^A-Z0-9]|$)/i.test(String(source || ''))
  || /(^|[^A-Z0-9])P[0-9]{6}-DIV[0-9]+([^A-Z0-9]|$)/i.test(String(source || ''));
const overseasReference = source => /(^|[^A-Z0-9])[PTD][0-9]{6}(-(S[0-9]+|DIV[0-9]+|RE))?-(PCT-)?(?!RE([^A-Z]|$))[A-Z]{2}([^A-Z]|$)/i.test(String(source || ''))
  || /(^|[^A-Z0-9])[PTD][0-9]{6}(-(S[0-9]+|DIV[0-9]+|RE))?-PCT([^A-Z]|$)/i.test(String(source || ''));
const englishText = (source, minimumLetters) => {
  const value = String(source || '').trim();
  if (!value || /[가-힣ㄱ-ㅎㅏ-ㅣ一-龥]/.test(value)) return false;
  return (value.match(/[A-Z]/gi) || []).length >= minimumLetters;
};

const foreignTerms = [
  '해외', '국제출원', '국제단계', '국내단계', '외국', '미국', '일본', '중국', '유럽',
  '대만', '인도', '캐나다', '호주', '영국', '독일', '프랑스', '싱가포르', '베트남',
  '태국', '인도네시아', '말레이시아', '필리핀', '브라질', '멕시코', '러시아',
  '카자흐스탄', '사우디', '아랍에미리트', 'PCT', 'WIPO', 'USPTO', 'EPO', 'JPO',
  'CNIPA', 'EUIPO', 'foreign', 'overseas', 'international', 'national phase',
  'office action', 'annuity', 'prosecution', 'Madrid', 'Hague',
];
const financeTerms = [
  '견적', '청구', '정산', '비용', '송금', '입금', 'quotation', 'quote', 'estimate',
  'invoice', 'billing', 'fee', 'fees', 'remittance', 'payment', 'debit note', 'credit note',
];
const projectTerms = [
  '과제', '정부지원', '지원사업', '사업계획', '협약', '사업비', '연구개발', 'R&D',
  '중간보고', '최종보고', '연차보고', '성과보고',
];

function isDomesticOa(subject, newBody) {
  const compactSubject = compact(subject);
  const compactBody = compact(newBody);
  if (!contains(compactSubject, '[EASYPAT_S]')) return false;
  return contains(compactBody, '업무구분:OA')
    || contains(compactBody, '업무내용:의견/보정서작성')
    || contains(compactBody, '담당자업무:의견/보정서작성');
}

function hasForeignClue(subject, newBody) {
  const combined = `${subject}\n${newBody.slice(0, 4000)}`;
  return containsAny(combined, foreignTerms) || matterCode(subject, 'PT') || overseasReference(subject);
}

function isOverseas(mail, subject, newBody) {
  const senderAddress = sender(mail);
  if (senderAddress === 'mslee@sspat.net' || senderAddress === 'hjlee@sspat.net') return true;
  if (overseasReference(subject)) return true;
  const people = participants(mail);
  const hasOverseasTeam = people.has('mslee@sspat.net')
    || people.has('hjlee@sspat.net')
    || senderAddress === 'jtjang@sspat.net';
  if (hasOverseasTeam && hasForeignClue(subject, newBody)) return true;
  return englishText(subject, 4) && englishText(newBody, 10);
}

const overseasFinance = (subject, body) => containsAny(`${subject}\n${body.slice(0, 4000)}`, financeTerms);
const overseasDesign = (subject, body) => matterCode(subject, 'D')
  || containsAny(`${subject}\n${body.slice(0, 4000)}`, ['디자인', 'industrial design', 'design application', 'Hague']);
const overseasTrademark = (subject, body) => matterCode(subject, 'T')
  || containsAny(`${subject}\n${body.slice(0, 4000)}`, ['상표', 'trademark', 'trade mark', 'Madrid', 'EUIPO']);
const overseasPatent = (subject, body) => matterCode(subject, 'P') || matterCode(subject, 'PT')
  || containsAny(`${subject}\n${body.slice(0, 4000)}`, [
    '특허', 'patent', 'PCT', 'office action', 'annuity', 'prosecution', 'national phase',
    'USPTO', 'EPO', 'JPO', 'CNIPA',
  ]);

function directOverseasDestination(subject, body) {
  if (contains(subject, '중국') && contains(subject, '가출원')) return '중국 가출원';
  if (matterCode(subject, 'PI')) return '해외 특허';
  if (overseasFinance(subject, body)) return '해외 견적/청구/정산';
  if (overseasDesign(subject, body)) return '해외 디자인';
  if (overseasTrademark(subject, body)) return '해외 상표';
  if (overseasPatent(subject, body)) return '해외 특허';
  return '해외 기타';
}

function expectedDestination(mail) {
  const senderAddress = sender(mail);
  const subject = String(mail.subject || '');
  const compactSubject = compact(subject);
  const newBody = extractNewBody(mail.body);

  if (senderAddress === 'mslee@sspat.net') return directOverseasDestination(subject, newBody);
  if (senderAddress === 'sspat99@sspat.net') {
    if (contains(subject, '해외출원안내')) return '해외 출원 자동 안내';
    if (contains(subject, '입금내역이 추가되었습니다')) return '입금 내역';
    if (contains(subject, 'EasyPAT 결재 시스템')) return '결재';
  }
  if (contains(compactSubject, '(경조사)회원') && contains(compactSubject, '변리사')) {
    return '대한변리사회 - 경조사';
  }
  if (senderAddress.endsWith('@kpaa.or.kr')) {
    if (contains(subject, '경조사')) return '대한변리사회 - 경조사';
    if (contains(subject, '연수')) return '대한변리사회 - 교육';
    return '대한변리사회 - 기타';
  }
  if (contains(compactSubject, '[업무전달]')
      && contains(compactSubject, '마감리스트')
      && contains(compactSubject, '송부의건')) return '기일관리';
  if (senderAddress === '1357@kised.or.kr'
      || containsAny(subject, ['모집 공고', '모집공고', '사업 공고', '사업공고'])) return '과제 자동 안내';
  if (contains(compactSubject, '[업무전달]') && contains(compactSubject, '사건등록완료')) return '사건등록';
  if (contains(subject, '중국') && contains(subject, '가출원')) return '중국 가출원';
  if (matterCode(subject, 'PI')) return '해외 특허';

  let overseas = isOverseas(mail, subject, newBody);
  const hasP = matterCode(subject, 'P');
  const hasT = matterCode(subject, 'T');
  const hasD = matterCode(subject, 'D');
  if (hasP && domesticSeries(subject)) overseas = false;
  if (hasP && isDomesticOa(subject, newBody)) return '국내특허 OA/ 우선심사 보완';
  if (!overseas && hasP && containsAny(compactSubject, [
    '등록결정서접수보고', '특허결정서접수보고', '분할여부확인요청',
  ])) return '국내특허 등록결정';
  if (!overseas && hasP && containsAny(compactSubject, [
    '[업무요청]의견제출통지서대응', '[업무요청]우선심사신청보완요구서',
  ])) return '국내특허 OA/ 우선심사 보완';

  const people = participants(mail);
  const projectTeam = ['jykim@sspat.net', 'hwlee@sspat.net', 'shchoi@sspat.net']
    .some(address => people.has(address));
  if (!overseas && projectTeam && containsAny(`${subject}\n${newBody.slice(0, 4000)}`, projectTerms)) {
    return '과제 관련';
  }
  if (overseas) {
    if (overseasFinance(subject, newBody)) return '해외 견적/청구/정산';
    if (overseasDesign(subject, newBody)) return '해외 디자인';
    if (overseasTrademark(subject, newBody)) return '해외 상표';
    if (overseasPatent(subject, newBody)) return '해외 특허';
  }
  const domesticTypes = Number(hasP) + Number(hasT) + Number(hasD);
  if (!overseas && domesticTypes === 1) {
    if (hasP) return '국내 특허';
    if (hasT) return '국내 상표';
    if (hasD) return '국내 디자인';
  }
  if (overseas) return '해외 기타';
  return '';
}

const inboxName = '받은 편지함';
const rows = (input.records || []).map(mail => {
  const expectedFolder = expectedDestination(mail);
  const actualFolder = String(mail.folderName || '');
  let outcome = 'matched';
  if (!expectedFolder && actualFolder === inboxName) outcome = 'correctly_unclassified';
  else if (!expectedFolder && actualFolder !== inboxName) outcome = 'unexpected_classified';
  else if (expectedFolder && actualFolder === inboxName) outcome = 'missed_in_inbox';
  else if (expectedFolder !== actualFolder) outcome = 'wrong_folder';
  const received = Date.parse(mail.receivedAt);
  const modified = Date.parse(mail.modifiedAt);
  const modificationLagSeconds = Number.isFinite(received) && Number.isFinite(modified)
    ? Math.round((modified - received) / 1000)
    : null;
  return {
    entryId: mail.entryId,
    internetMessageId: mail.internetMessageId,
    receivedAt: mail.receivedAt,
    modifiedAt: mail.modifiedAt,
    modificationLagSeconds,
    unread: Boolean(mail.unread),
    senderEmail: mail.senderEmail,
    subject: mail.subject,
    actualFolder,
    expectedFolder,
    outcome,
  };
});

const byOutcome = Object.fromEntries([...new Set(rows.map(row => row.outcome))]
  .sort().map(outcome => [outcome, rows.filter(row => row.outcome === outcome).length]));
const expectedClassified = rows.filter(row => row.expectedFolder);
const matchedClassified = expectedClassified.filter(row => row.outcome === 'matched');
const nearArrival = matchedClassified.filter(row => row.modificationLagSeconds !== null
  && row.modificationLagSeconds >= 0 && row.modificationLagSeconds <= 300);
const mismatches = rows.filter(row => ['missed_in_inbox', 'wrong_folder'].includes(row.outcome));
const unexpectedClassified = rows.filter(row => row.outcome === 'unexpected_classified');
const observedFolders = [...new Set(rows.map(row => row.actualFolder))].sort();
const result = {
  inputPath: path.resolve(inputPath),
  inputHash: createHash('sha256').update(readFileSync(inputPath)).digest('hex'),
  observedAt: input.observedAt,
  from: input.from,
  to: input.to,
  total: rows.length,
  byOutcome,
  expectedClassified: expectedClassified.length,
  matchedClassified: matchedClassified.length,
  nearArrivalMatched: nearArrival.length,
  mismatchCount: mismatches.length,
  unexpectedClassifiedCount: unexpectedClassified.length,
  observedFolders,
  mismatches,
  unexpectedClassified,
  rows,
};
writeFileSync(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({
  total: result.total,
  byOutcome,
  expectedClassified: result.expectedClassified,
  matchedClassified: result.matchedClassified,
  nearArrivalMatched: result.nearArrivalMatched,
  mismatchCount: result.mismatchCount,
  unexpectedClassifiedCount: result.unexpectedClassifiedCount,
  outputPath: path.resolve(outputPath),
}));
