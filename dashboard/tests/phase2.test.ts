import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasExactMatterReference, matterReferenceTokens, parseMatterNumber } from '../lib/matter-number';
import { importGroupReviewFindings, recordGroupReviewFeedback } from '../lib/group-review';
import { analysisStatus } from '../lib/analysis';
import {
  createMatter,
  createMatterGroup,
  createOrganization,
  createPerson,
  databaseStatus,
  getMatter,
  importConfirmedMatterGroups,
  importOutlookMail,
  listMatters,
  listSyncRuns,
  updateEntityNote,
  updateGroupType,
  updateOrganizationBusinessType,
  withDatabase,
} from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-phase2-'));
process.env.SSPAT_WORK_DB_PATH = path.join(temporaryRoot, 'sspat-work.db');
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

try {
  assert.ok(databaseStatus().migrations.length >= 2);
  let detail = createMatter({ ourRef: 'P251556', workType: '출원', stage: '출원', currentStatus: '사건 등록', note: '사건 최초 비고' });
  const matterId = String(detail.matter.id);
  detail = createOrganization(matterId, { name: '테스트 주식회사', businessType: '법인', note: '회사 비고' });
  detail = createPerson(matterId, { name: '홍길동', email: 'hong@example.com', organizationId: detail.organizations[0].id, note: '사람 비고' });
  detail = createMatterGroup(matterId, { groupRef: 'GP251556', note: '그룹 비고' });
  assert.equal(detail.organizations[0].note, '회사 비고');
  assert.equal(detail.organizations[0].businessType, '법인');
  assert.throws(() => createOrganization(matterId, { name: '잘못된 회사', businessType: '공기업' }), /회사 구분/);
  updateOrganizationBusinessType(String(detail.organizations[0].id), '개인사업자', Number(detail.organizations[0].rowVersion));
  assert.throws(() => updateOrganizationBusinessType(String(detail.organizations[0].id), '법인', Number(detail.organizations[0].rowVersion)), /먼저 반영/);
  detail = getMatter(matterId);
  assert.equal(detail.organizations[0].businessType, '개인사업자');
  assert.equal(detail.people[0].note, '사람 비고');
  assert.equal(detail.groups[0].note, '그룹 비고');
  assert.equal(detail.groups[0].groupType, '미분류');
  const groupId = String(detail.groups[0].id);
  updateGroupType(groupId, '시리즈', 1);
  assert.throws(() => updateGroupType(groupId, '포트폴리오', 1), /새로고침/);
  assert.throws(() => updateGroupType(groupId, ' ', 2), /입력/);
  assert.throws(() => createMatterGroup(matterId, { groupRef: 'GP251556', groupType: '정부지원사업' }), /기존 그룹 종류/);
  const other = createMatter({ ourRef: 'PP260002' });
  createMatterGroup(String(other.matter.id), { groupRef: 'GP251556', groupType: '시리즈' });
  createMatterGroup(matterId, { groupRef: 'GP251556-2', groupType: '정부지원사업' });
  createMatterGroup(matterId, { groupRef: 'GP251556-3', groupType: '포트폴리오' });
  createMatterGroup(matterId, { groupRef: 'GP251556-4', groupType: '공동연구' });
  assert.equal(getMatter(matterId).groups.length, 4);
  assert.equal(getMatter(String(other.matter.id)).groups[0].groupType, '시리즈');
  assert.equal(getMatter(String(other.matter.id)).groups[0].representativeOurRef, 'P251556');
  assert.deepEqual(getMatter(String(other.matter.id)).groups[0].memberRefs, ['P251556', 'PP260002']);
  assert.equal(getMatter(matterId).groups[0].note, '그룹 비고');

  const confirmedGroups = importConfirmedMatterGroups({
    sourceName: '업무관리.xlsx',
    sourceHash: 'a'.repeat(64),
    sourceLastModified: '2026-09-14T00:00:00.000Z',
    groups: [{
      groupRef: 'GP260101',
      groupType: '포트폴리오',
      representativeRef: 'P260101',
      members: ['P260101', 'P260102'],
      note: '업무관리 Excel에서 확인된 포트폴리오 2건',
      confidence: 0.99,
      evidence: [{ sheet: '2026', range: 'B2:K3', excerpt: 'P260101, P260102 포트폴리오' }],
    }],
  });
  assert.equal(confirmedGroups.createdGroups, 1);
  assert.equal(confirmedGroups.createdMatters, 2);
  assert.equal(confirmedGroups.linkedMembers, 2);
  const repeatedGroups = importConfirmedMatterGroups({
    sourceName: '업무관리.xlsx',
    sourceHash: 'a'.repeat(64),
    sourceLastModified: '2026-09-14T00:00:00.000Z',
    groups: [{
      groupRef: 'GP260101', groupType: '포트폴리오', representativeRef: 'P260101', members: ['P260101', 'P260102'],
      note: '업무관리 Excel에서 확인된 포트폴리오 2건', confidence: 0.99,
      evidence: [{ sheet: '2026', range: 'B2:K3', excerpt: 'P260101, P260102 포트폴리오' }],
    }],
  });
  assert.equal(repeatedGroups.duplicate, true);
  const groupReview = importGroupReviewFindings({
    sourceName: '업무관리.xlsx',
    sourceHash: 'b'.repeat(64),
    sourceLastModified: '2026-09-14T00:00:00.000Z',
    findings: [{
      key: 'unsupported-ppt', category: 'unsupported_number_format', title: 'PPT 번호 확인', organization: '테스트 회사',
      knownMatterRefs: ['PT260101'], rawMatterRefs: ['PPT260001'], expectedCount: 2, knownCount: 1,
      questions: ['PPT 번호의 의미를 확인해 주세요.'], reason: '현재 번호 파서에 정의되지 않았습니다.', confidence: 1,
      evidence: [{ sheet: '2026', range: 'B10:K10', excerpt: 'PT260101, PPT260001' }],
    }],
  });
  assert.equal(groupReview.findingCount, 1);
  const reviewFeedback = recordGroupReviewFeedback(groupReview.runId, [{
    key: 'unsupported-ppt', status: 'resolved', answer: 'PPT는 상상플러스 가출원이며 한 그룹으로 통합한다.', remainingQuestions: [],
  }]);
  assert.equal(reviewFeedback.recorded, 1);
  assert.equal(recordGroupReviewFeedback(groupReview.runId, [{ key: 'unsupported-ppt', status: 'resolved', answer: 'PPT는 상상플러스 가출원이며 한 그룹으로 통합한다.' }]).duplicate, 1);
  assert.equal(recordGroupReviewFeedback(groupReview.runId, [{
    key: 'unsupported-ppt', status: 'partially_resolved', answer: '그룹 범위는 확인했고 대표 사건만 남았다.', remainingQuestions: ['대표 사건을 확인해 주세요.'],
  }]).recorded, 1);
  assert.equal(importGroupReviewFindings({
    sourceName: '업무관리.xlsx', sourceHash: 'b'.repeat(64), sourceLastModified: '2026-09-14T00:00:00.000Z',
    findings: [{ key: 'unsupported-ppt', category: 'unsupported_number_format', title: 'PPT 번호 확인', organization: '테스트 회사', knownMatterRefs: ['PT260101'], rawMatterRefs: ['PPT260001'], expectedCount: 2, knownCount: 1, questions: ['PPT 번호의 의미를 확인해 주세요.'], reason: '현재 번호 파서에 정의되지 않았습니다.', confidence: 1, evidence: [{ sheet: '2026', range: 'B10:K10', excerpt: 'PT260101, PPT260001' }] }],
  }).duplicate, true);
  withDatabase((db) => {
    const reviewRun = db.prepare("SELECT result_json FROM decision_run WHERE operation='group_candidate_review'").get() as any;
    assert.equal(JSON.parse(reviewRun.result_json).findings[0].rawMatterRefs[0], 'PPT260001');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decision_item WHERE decision_run_id=? AND review_status='needs_user_input'").get(groupReview.runId) as any).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM user_feedback WHERE reason_code='new_evidence'").get() as any).n, 2);
  });
  const importedRepresentative = listMatters().find((matter: any) => matter.ourRef === 'P260101');
  // Same-millisecond answers must retain insertion order, not random UUID order.
  const groupState = () => withDatabase(db => JSON.stringify({
    events: db.prepare('SELECT * FROM event ORDER BY rowid').all(),
    feedback: db.prepare('SELECT * FROM user_feedback ORDER BY rowid').all(),
    comparisons: db.prepare('SELECT * FROM decision_comparison ORDER BY rowid').all(),
    decisions: db.prepare('SELECT * FROM decision_item ORDER BY rowid').all(),
    groups: db.prepare('SELECT * FROM matter_group ORDER BY rowid').all(),
    matters: db.prepare('SELECT * FROM matter ORDER BY rowid').all(),
  }));
  withDatabase(db => {
    const history = db.prepare('SELECT f.* FROM user_feedback f JOIN decision_item d ON d.id=f.decision_item_id WHERE d.decision_run_id=? ORDER BY f.rowid').all(groupReview.runId) as any[];
    assert.equal(history.length, 2);
    assert.equal(history[1].before_value_json, history[0].final_value_json);
    assert.equal(db.prepare('SELECT before_json FROM event WHERE id=?').get(history[1].event_id)!.before_json, history[0].final_value_json);
    db.prepare('UPDATE user_feedback SET created_at=? WHERE decision_item_id=?').run('2026-09-14T01:00:00.000Z', history[0].decision_item_id);
  });
  assert.equal(analysisStatus().groupReview.findings[0].userAnswer.status, 'partially_resolved');
  const beforeDuplicate = groupState();
  assert.equal(recordGroupReviewFeedback(groupReview.runId, [{ key: 'unsupported-ppt', status: 'partially_resolved', answer: '그룹 범위는 확인했고 대표 사건만 남았다.', remainingQuestions: ['대표 사건을 확인해 주세요.'] }]).duplicate, 1);
  assert.equal(groupState(), beforeDuplicate);
  // A later invalid answer rolls the entire transaction back, including the first answer.
  assert.throws(() => recordGroupReviewFeedback(groupReview.runId, [
    { key: 'unsupported-ppt', status: 'resolved', answer: '대표 사건까지 확인했다.' },
    { key: 'missing-key', status: 'resolved', answer: '없는 항목' },
  ]), /해당 검토 실행의 항목/);
  assert.equal(groupState(), beforeDuplicate);
  assert.throws(() => recordGroupReviewFeedback(groupReview.runId, [{ key: 'unsupported-ppt', status: 'partially_resolved', answer: '질문 누락' }]), /남은 질문이 필요/);
  assert.equal(groupState(), beforeDuplicate);
  assert.ok(importedRepresentative);
  assert.equal(importedRepresentative.sourceType, 'excel');
  assert.equal(importedRepresentative.userConfirmed, false);
  const importedGroup = getMatter(String(importedRepresentative.id)).groups[0];
  assert.equal(importedGroup.representativeOurRef, 'P260101');
  assert.deepEqual(importedGroup.memberRefs, ['P260101', 'P260102']);
  withDatabase((db) => {
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM decision_run WHERE operation='group_reconciliation' AND status='succeeded'").get() as any).n, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM decision_item WHERE decision_run_id=?').get(confirmedGroups.runId) as any).n, 3);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM source_observation WHERE source_type='excel' AND field_path='groups.membership'").get() as any).n, 2);
  });

  updateEntityNote('organization', String(detail.organizations[0].id), '회사 비고 수정', Number(detail.organizations[0].rowVersion));
  detail = getMatter(matterId);
  assert.equal(detail.organizations[0].note, '회사 비고 수정');

  const records = [
    { entryId: 'mail-1', folderPath: '\\메일함\\받은 편지함', direction: 'received' as const, subject: '[P251556] 초안 검토 요청', senderName: '홍길동', senderEmail: 'hong@example.com', to: '장진태', cc: '', mailAt: '2026-09-10T01:00:00.000Z', body: '초안의 청구항 1을 확인해 주세요.' },
    { entryId: 'mail-2', folderPath: '\\메일함\\보낸 편지함', direction: 'sent' as const, subject: 'RE: P251556 초안 검토 요청', senderName: '장진태', senderEmail: 'jang@example.com', to: '홍길동', cc: '', mailAt: '2026-09-10T02:00:00.000Z', body: '수정본을 내일까지 보내드리겠습니다.' },
    { entryId: 'mail-3', folderPath: '\\메일함\\받은 편지함', direction: 'received' as const, subject: 'PP251234 사건 등록', senderName: '고객', mailAt: '2026-09-11T03:00:00.000Z', body: '신규 사건 등록 요청입니다. 내부 단계 표시는 S1입니다.' },
  ];
  const first = importOutlookMail(records, { from: '2026-09-10T00:00:00.000Z', to: '2026-09-12T00:00:00.000Z', folders: ['받은 편지함', '보낸 편지함'] });
  assert.equal(first.imported, 3);
  assert.equal(first.linked, 3);
  assert.equal(first.affectedSummaries, 2);
  const second = importOutlookMail(records, { from: '2026-09-10T00:00:00.000Z', to: '2026-09-12T00:00:00.000Z', folders: ['받은 편지함', '보낸 편지함'] });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 3);
  detail = getMatter(matterId);
  assert.equal(detail.mailSummaries.length, 1);
  assert.match(String(detail.mailSummaries[0].content), /청구항 1/);
  assert.match(String(detail.mailSummaries[0].content), /수정본/);
  const inferred = listMatters().find((matter: any) => matter.ourRef === 'PP251234');
  assert.ok(inferred);
  assert.equal(inferred.sourceType, 'mail_inference');
  assert.equal(inferred.userConfirmed, false);
  assert.equal(listMatters().some((matter: any) => matter.ourRef === 'S1'), false);
  assert.equal(listSyncRuns().length, 2);

  assert.deepEqual(matterReferenceTokens('P261775-S1-CN(PA), T261418-TH, P241387-PCT'), ['P261775-S1-CN(PA)', 'T261418-TH', 'P241387-PCT']);
  for (const text of ['P261775-S1', 'P261775-CN(PA)', 'P261775-CN-1', 'P2617759', 'XP261775', 'P261775(추가 설명)']) {
    assert.equal(hasExactMatterReference(text, 'P261775'), false, text);
  }
  assert.equal(hasExactMatterReference('[p261775] 검토', 'P261775'), true);
  assert.equal(hasExactMatterReference('[P261823_고하정님]', 'P261823'), true);
  assert.equal(hasExactMatterReference('계약서_P262056외', 'P262056'), true);
  assert.equal(hasExactMatterReference('P261775/P261776', 'P261775'), true);
  assert.equal(hasExactMatterReference('P261775-CN(PA)', 'P261775-CN'), false);
  // User-confirmed regular CN vs provisional CN(PA): no alias folding.
  const regularCN = parseMatterNumber('P261775-CN');
  const provisionalCN = parseMatterNumber('P261775-CN(PA)');
  assert.notEqual(regularCN.normalized, provisionalCN.normalized);
  assert.equal(regularCN.countryCode, 'CN');
  assert.equal(provisionalCN.countryCode, 'CN');
  const plusProvisional = parseMatterNumber('PPT261001');
  assert.equal(plusProvisional.office, '상상플러스');
  assert.equal(plusProvisional.kind, 'provisional_project');
  assert.equal(plusProvisional.normalized, 'PPT261001');
  assert.deepEqual(matterReferenceTokens('PT261166, PPT261001, PPT261002'), ['PT261166', 'PPT261001', 'PPT261002']);
  const opaque = importOutlookMail([{ entryId: 'opaque-suffix', folderPath: '받은 편지함', direction: 'received', subject: 'P261775-X1-CN(PA), P252302-CN(UNKNOWN), JTX26281-MAD(TH)', mailAt: '2026-09-11T03:00:00.000Z', body: 'P261960-X1 초안 안내' }], { from: '2026-09-11', to: '2026-09-12', folders: ['받은 편지함'] });
  assert.equal(opaque.linked, 0);
  assert.equal(listMatters().some((m: any) => ['P261775', 'P252302-CN', 'P261960'].includes(m.ourRef)), false);
  const multiple = importOutlookMail([{ entryId: 'multiple-exact-refs', folderPath: '받은 편지함', direction: 'received', subject: 'P261960-DIV1 및 P261960-S1 안내', mailAt: '2026-09-11T04:00:00.000Z', body: '두 사건에 모두 관련된 메일입니다.' }], { from: '2026-09-11', to: '2026-09-12', folders: ['받은 편지함'] });
  assert.equal(multiple.linked, 2);
  assert.ok(listMatters().some((m: any) => m.ourRef === 'P261960-DIV1'));
  assert.ok(listMatters().some((m: any) => m.ourRef === 'P261960-S1'));

  console.log('Phase 2 read-only mail foundation tests passed.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
