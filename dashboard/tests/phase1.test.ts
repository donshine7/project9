import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMatterNumber } from '../lib/matter-number';
import { activateSourcePriorityPolicy, recordEasyPatVerification } from '../lib/easypat-verification';
import { loadSourcePriorityPolicy, SOURCE_PRIORITY_VERSION } from '../lib/source-policy';
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
  withDatabase,
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

  const initialDatabaseStatus = databaseStatus();
  assert.equal(initialDatabaseStatus.integrity, 'ok');
  assert.ok(initialDatabaseStatus.migrations.some((migration: any) => migration.version === '007_work_refresh_tracking.sql'));
  withDatabase((db) => {
    const runColumns = db.prepare('PRAGMA table_info(work_refresh_run)').all() as Array<{ name: string }>;
    assert.ok(runColumns.some((column) => column.name === 'requested_at'));
    assert.ok(runColumns.some((column) => column.name === 'completed_at'));
    assert.ok(runColumns.some((column) => column.name === 'reviewed_mail_from'));
    assert.ok(runColumns.some((column) => column.name === 'reviewed_mail_to'));

    const syncColumns = db.prepare('PRAGMA table_info(sync_run)').all() as Array<{ name: string }>;
    const decisionColumns = db.prepare('PRAGMA table_info(decision_run)').all() as Array<{ name: string }>;
    assert.ok(syncColumns.some((column) => column.name === 'work_refresh_run_id'));
    assert.ok(decisionColumns.some((column) => column.name === 'work_refresh_run_id'));

    const createdAt = '2026-09-18T01:00:00.000Z';
    db.prepare(`
      INSERT INTO work_refresh_run(
        id, request_channel, requested_by, requested_at, mail_window_from, mail_window_to,
        target_mail_count, pending_mail_count, created_at, updated_at
      ) VALUES (?, 'codex', '장진태', ?, ?, ?, 1, 1, ?, ?)
    `).run('refresh-schema-test', createdAt, '2026-09-17T00:00:00.000Z', createdAt, createdAt, createdAt);
    db.prepare(`
      INSERT INTO work_refresh_stage(
        id, work_refresh_run_id, stage_key, input_count, created_at, updated_at
      ) VALUES (?, ?, 'collection', 1, ?, ?)
    `).run('refresh-stage-test', 'refresh-schema-test', createdAt, createdAt);
    db.prepare(`
      INSERT INTO sync_run(
        id, requested_from, requested_to, folder_scope_json, status,
        processed_count, error_count, started_at, completed_at, work_refresh_run_id
      ) VALUES (?, ?, ?, '[]', 'completed', 1, 0, ?, ?, ?)
    `).run('refresh-sync-test', '2026-09-17T00:00:00.000Z', createdAt, createdAt, createdAt, 'refresh-schema-test');
    db.prepare(`
      INSERT INTO mail_item(
        id, outlook_entry_id, folder_path, direction, subject, recipients_json,
        mail_at, body_text, body_hash, imported_at
      ) VALUES (?, ?, '받은 편지함', 'received', '업무 정리 추적 시험', '{}', ?, '시험 본문', ?, ?)
    `).run('refresh-mail-test', 'refresh-mail-entry-test', '2026-09-17T01:00:00.000Z', 'a'.repeat(64), createdAt);
    db.prepare(`
      INSERT INTO work_refresh_mail(
        work_refresh_run_id, mail_id, source_sync_run_id, review_status, reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'applied', ?, ?, ?)
    `).run('refresh-schema-test', 'refresh-mail-test', 'refresh-sync-test', createdAt, createdAt, createdAt);
    db.prepare(`
      INSERT INTO work_refresh_result(
        id, work_refresh_run_id, work_refresh_stage_id, subject_type, subject_key,
        outcome, source_type, source_id, source_at, created_at
      ) VALUES (?, ?, ?, 'mail', ?, 'applied', 'mail', ?, ?, ?)
    `).run('refresh-result-test', 'refresh-schema-test', 'refresh-stage-test', 'refresh-mail-test', 'refresh-mail-test', '2026-09-17T01:00:00.000Z', createdAt);
    const tracked = db.prepare(`
      SELECT r.requested_at, m.mail_at AS source_at, s.completed_at
      FROM work_refresh_run r
      JOIN work_refresh_mail target ON target.work_refresh_run_id = r.id
      JOIN mail_item m ON m.id = target.mail_id
      JOIN sync_run s ON s.id = target.source_sync_run_id
      WHERE r.id = ?
    `).get('refresh-schema-test') as any;
    assert.equal(tracked.requested_at, createdAt);
    assert.equal(tracked.source_at, '2026-09-17T01:00:00.000Z');
    assert.equal(tracked.completed_at, createdAt);
    assert.throws(() => db.prepare(`
      INSERT INTO work_refresh_mail(
        work_refresh_run_id, mail_id, review_status, created_at, updated_at
      ) VALUES (?, 'missing-mail', 'pending', ?, ?)
    `).run('refresh-schema-test', createdAt, createdAt), /foreign key/i);
    assert.throws(() => db.prepare(`
      INSERT INTO work_refresh_stage(
        id, work_refresh_run_id, stage_key, input_count, processed_count, created_at, updated_at
      ) VALUES (?, ?, 'invalid-counts', 0, 1, ?, ?)
    `).run('refresh-stage-invalid', 'refresh-schema-test', createdAt, createdAt), /constraint/i);
    assert.throws(() => db.prepare(`
      INSERT INTO work_refresh_run(
        id, request_channel, requested_by, requested_at, mail_window_from, mail_window_to, created_at, updated_at
      ) VALUES (?, 'codex', '장진태', ?, ?, ?, ?, ?)
    `).run('refresh-invalid-window', createdAt, createdAt, '2026-09-17T00:00:00.000Z', createdAt, createdAt), /constraint/i);
  });
  const sourcePolicy = loadSourcePriorityPolicy();
  assert.equal(sourcePolicy.version, SOURCE_PRIORITY_VERSION);
  assert.deepEqual(sourcePolicy.externalPriority, ['easy_pat', 'registration_mail', 'excel', 'mail_inference']);
  assert.equal(activateSourcePriorityPolicy().duplicate, false);
  assert.equal(activateSourcePriorityPolicy().duplicate, true);
  const created = createMatter({ ourRef: 'P251556', workType: '출원', serviceType: '우선심사출원', stage: '출원', currentStatus: '사건 등록' });
  const matterId = String(created.matter.id);
  assert.equal(created.works.length, 1);

  const easyPatEnvelope = {
    tool: 'easypat_get_matter_summary',
    arguments: { matterReference: 'P251556' },
    structuredContent: { matterReference: 'P251556', rightType: '특허', applicationKind: '출원', applicationDivision: null, applicationDate: '2026-09-01', applicationNumber: '10-2026-0000001', titleKorean: '시험 발명', status: '출원' },
    observedAt: '2026-09-18T09:00:00.000Z',
  } as const;
  const easyPatRun = recordEasyPatVerification(easyPatEnvelope);
  assert.equal(easyPatRun.duplicate, false);
  assert.equal(recordEasyPatVerification(easyPatEnvelope).duplicate, true);
  const easyPatDetail = getMatter(matterId);
  assert.equal(easyPatDetail.matter.sourceType, 'user_input');
  assert.equal(easyPatDetail.easyPat.verified, true);
  assert.equal(easyPatDetail.easyPat.lastObservedAt, '2026-09-18T09:00:00.000Z');
  assert.ok(easyPatDetail.easyPat.observations.some((item: any) => item.fieldPath === 'easy_pat.summary.applicationNumber' && item.observedValue === '10-2026-0000001'));
  assert.throws(() => recordEasyPatVerification({ ...easyPatEnvelope, structuredContent: { ...easyPatEnvelope.structuredContent, matterReference: 'P251557' } }), /요청과 결과/);

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
