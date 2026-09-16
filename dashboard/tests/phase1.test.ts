import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMatterNumber } from '../lib/matter-number';
import {
  archiveAction,
  archiveNote,
  createAction,
  createBackup,
  createMatter,
  createNote,
  createWorkItem,
  databaseStatus,
  getMatter,
  listMatters,
  restoreBackup,
  updateAction,
  updateNote,
  updateWorkItem,
} from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-phase1-'));
process.env.SSPAT_WORK_DB_PATH = path.join(temporaryRoot, 'sspat-work.db');
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

try {
  assert.deepEqual(parseMatterNumber('pp251556'), {
    normalized: 'PP251556', office: '상상플러스', kind: 'domestic_patent', countryCode: 'KR', baseRef: 'PP251556', parentRef: null, relationType: null, suffixes: [],
  });
  assert.equal(parseMatterNumber('P251556-PRO1').relationType, 'priority_basis');
  assert.deepEqual(parseMatterNumber('P251556-US-DIV1').suffixes, ['US', 'DIV1']);
  assert.deepEqual(parseMatterNumber('P252187-DIV1'), {
    normalized: 'P252187-DIV1', office: '상상특허', kind: 'domestic_patent', countryCode: 'KR',
    baseRef: 'P252187', parentRef: 'P252187', relationType: 'divisional', suffixes: ['DIV1'],
  });
  assert.equal(parseMatterNumber('P251556-PCT').kind, 'pct');
  assert.equal(parseMatterNumber('P251556-RE').kind, 'refiling');
  assert.equal(parseMatterNumber('S260001').kind, 'other_matter');
  assert.equal(parseMatterNumber('AT251009').kind, 'appeal');
  assert.equal(parseMatterNumber('PT260001').kind, 'provisional_project');
  assert.equal(parseMatterNumber('T261418-TH').kind, 'trademark');
  assert.equal(parseMatterNumber('D261119').kind, 'design');
  assert.equal(parseMatterNumber('D261119').countryCode, 'KR');
  assert.deepEqual(parseMatterNumber('d261119-jp'), { normalized:'D261119-JP', office:'상상특허', kind:'design', countryCode:'JP', baseRef:'D261119', parentRef:null, relationType:null, suffixes:['JP'] });
  assert.equal(parseMatterNumber('D261119-JP-DIV1').normalized, 'D261119-JP-DIV1');
  assert.equal(parseMatterNumber('D261119-MD(-JP)').countryCode, null);
  assert.throws(() => parseMatterNumber('D261119(설명)'), /지원하지 않는/);
  assert.throws(() => parseMatterNumber('D261119-JP-'), /지원하지 않는/);
  assert.equal(parseMatterNumber('T221358-MD(-EP)').countryCode, null);
  assert.equal(parseMatterNumber('P261775-S1').baseRef, 'P261775-S1');
  assert.equal(parseMatterNumber('P261775-S1').parentRef, null);
  assert.equal(parseMatterNumber('P261775-S1-CN(PA)').parentRef, 'P261775-S1');
  assert.equal(parseMatterNumber('P252302-CN(PA)').normalized, 'P252302-CN(PA)');
  assert.deepEqual(parseMatterNumber('P252302-CN(PA)').suffixes, ['CN','PA']);
  assert.equal(parseMatterNumber('P261775-S1-CN').countryCode, 'CN');

  assert.equal(databaseStatus().integrity, 'ok');
  const created = createMatter({ ourRef: 'P251556', workType: '출원', serviceType: '우선심사출원', stage: '출원', currentStatus: '사건 등록' });
  const matterId = String(created.matter.id);
  assert.equal(created.works.length, 1);

  const withWork = createWorkItem(matterId, { workType: '중간사건', serviceType: null, stage: '중간사건', currentStatus: '의견통지' });
  const secondWork = withWork.works.find((item: any) => item.workType === '중간사건');
  assert.ok(secondWork);
  const workUpdated = updateWorkItem(String(secondWork.id), { currentStatus: '제출완료', expectedVersion: Number(secondWork.rowVersion) });
  assert.equal(workUpdated.works.find((item: any) => item.id === secondWork.id)?.currentStatus, '제출완료');

  const withNote = createNote(matterId, '고객 회신을 확인한다.');
  const note = withNote.notes[0];
  const noteUpdated = updateNote(String(note.id), '고객 회신 확인 완료.', Number(note.rowVersion));
  assert.equal(noteUpdated.notes[0].content, '고객 회신 확인 완료.');

  const withAction = createAction(matterId, { workItemId: String(secondWork.id), title: 'OA 대응안 검토', assignee: '황현우', priority: '높음' });
  const action = withAction.actions[0];
  const actionUpdated = updateAction(String(action.id), { assignee: '장진태', status: '진행중', expectedVersion: Number(action.rowVersion) });
  assert.equal(actionUpdated.actions[0].assignee, '장진태');
  assert.equal(actionUpdated.actions[0].status, '진행중');

  const backup = createBackup();
  createMatter({ ourRef: 'P251557', workType: '출원', stage: '출원', currentStatus: '사건 등록' });
  assert.equal(listMatters().length, 2);
  restoreBackup(backup.file, 'RESTORE');
  assert.equal(listMatters().length, 1);

  const restored = getMatter(matterId);
  const restoredNote = restored.notes[0];
  const restoredAction = restored.actions[0];
  archiveNote(String(restoredNote.id), Number(restoredNote.rowVersion));
  archiveAction(String(restoredAction.id), Number(restoredAction.rowVersion));
  const archived = getMatter(matterId);
  assert.equal(archived.notes.length, 0);
  assert.equal(archived.actions.length, 0);
  assert.ok(archived.events.length >= 8);

  console.log('Phase 1 data foundation tests passed.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
