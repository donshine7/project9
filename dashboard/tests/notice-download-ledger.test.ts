import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMatter, databaseStatus, withDatabase } from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-notice-ledger-'));
process.env.SSPAT_WORK_DB_PATH = path.join(temporaryRoot, 'sspat-work.db');
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

try {
  const status = databaseStatus();
  assert.ok(status.migrations.some((migration: any) => migration.version === '009_notice_download_ledger.sql'));
  assert.ok(status.migrations.some((migration: any) => migration.version === '010_notice_operations_and_projects.sql'));
  assert.ok(status.migrations.some((migration: any) => migration.version === '011_notice_response_progress.sql'));
  const created = createMatter({ ourRef: 'P261487', workType: '중간사건', stage: '중간사건', currentStatus: '의견통지' });
  const matterId = String(created.matter.id);
  const at = '2026-09-18T10:00:00.000Z';
  withDatabase((db) => {
    const expectedTables = ['notice', 'notice_mail_link', 'notice_attachment', 'download_job', 'download_package', 'notice_detection_run', 'notice_pipeline_event', 'notice_operator_request', 'notice_project_link', 'notice_project_stage', 'notice_project_event', 'notice_project_artifact', 'notice_project_approval', 'notice_project_task_link'];
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
    assert.ok(expectedTables.every((name) => tables.has(name)));
    db.prepare(`
      INSERT INTO notice(
        id, notice_key, matter_id, matter_reference, notice_kind, identity_basis,
        progress_sequence, notice_date, due_date, oa_sequence, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'P261487', 'opinion_submission', 'progress_sequence_and_notice_date', '7', '2026-09-11', '2027-01-11', 1, 'ready', ?, ?)
    `).run('notice-1', 'notice_' + 'a'.repeat(64), matterId, at, at);
    db.prepare(`
      INSERT INTO notice(
        id, notice_key, matter_id, matter_reference, notice_kind, identity_basis,
        notice_date, rejection_sequence, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'P261487', 'rejection_decision', 'notice_date_provisional', '2026-09-12', 2, 'candidate', ?, ?)
    `).run('notice-rejection', 'notice_' + 'b'.repeat(64), matterId, at, at);
    db.prepare(`
      INSERT INTO notice(
        id, notice_key, matter_id, matter_reference, notice_kind, identity_basis,
        notice_date, supplement_sequence, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'P261487', 'priority_exam_supplement_request', 'notice_date_provisional', '2026-09-13', 1, 'candidate', ?, ?)
    `).run('notice-supplement', 'notice_' + 'c'.repeat(64), matterId, at, at);
    assert.throws(() => db.prepare("UPDATE notice SET oa_sequence=1 WHERE id='notice-rejection'").run(), /check/i);
    assert.throws(() => db.prepare(`
      INSERT INTO notice(
        id, notice_key, matter_id, matter_reference, notice_kind, identity_basis,
        notice_date, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'P261487', 'opinion_submission', 'notice_date_provisional', '2026-09-11', 'candidate', ?, ?)
    `).run('notice-duplicate', 'notice_' + 'a'.repeat(64), matterId, at, at), /unique/i);
    db.prepare(`
      INSERT INTO download_job(
        id, notice_id, attachment_version, package_version, expected_file_name,
        status, requested_at, updated_at
      ) VALUES (?, 'notice-1', 1, 1, '[P261487] 1OA (2026-09-11)(2027-01-11).zip', 'queued', ?, ?)
    `).run('job-1', at, at);
    assert.throws(() => db.prepare(`
      INSERT INTO download_job(
        id, notice_id, attachment_version, package_version, expected_file_name,
        status, requested_at, updated_at
      ) VALUES (?, 'notice-1', 1, 2, 'second.zip', 'running', ?, ?)
    `).run('job-2', at, at), /unique/i);
  });

  const upgradePath = path.join(temporaryRoot, 'upgrade-from-009.db');
  const oldDb = new DatabaseSync(upgradePath);
  oldDb.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migration(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);');
  const migrationRoot = path.resolve(process.cwd(), 'db', 'migrations');
  for (const file of readdirSync(migrationRoot).filter((name) => /^00[1-9].*\.sql$/i.test(name)).sort()) {
    oldDb.exec('BEGIN IMMEDIATE');
    oldDb.exec(readFileSync(path.join(migrationRoot, file), 'utf8'));
    oldDb.prepare('INSERT INTO schema_migration(version,applied_at) VALUES (?,?)').run(file, at);
    oldDb.exec('COMMIT');
  }
  oldDb.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at)
    VALUES ('matter-upgrade','P269999','상상특허','domestic_patent','P269999','[]','manual',1,1,?,?)`).run(at, at);
  oldDb.prepare(`INSERT INTO notice(id,notice_key,matter_id,matter_reference,notice_kind,identity_basis,notice_date,due_date,oa_sequence,status,created_at,updated_at)
    VALUES ('notice-upgrade','notice_${'d'.repeat(64)}','matter-upgrade','P269999','rejection_decision','notice_date_provisional','2026-09-01','2027-01-01',2,'published',?,?)`).run(at, at);
  oldDb.prepare(`INSERT INTO notice_attachment(id,notice_id,attachment_version,source_position,file_name,file_size_bytes,sha256,state,created_at,updated_at)
    VALUES ('attachment-upgrade','notice-upgrade',1,1,'decision.pdf',10,?,'verified',?,?)`).run('e'.repeat(64), at, at);
  oldDb.prepare(`INSERT INTO download_job(id,notice_id,attachment_version,package_version,expected_file_name,status,requested_at,completed_at,updated_at)
    VALUES ('job-upgrade','notice-upgrade',1,1,'decision.zip','published',?,?,?)`).run(at, at, at);
  oldDb.prepare(`INSERT INTO download_package(id,download_job_id,notice_id,package_version,file_name,destination_path,sha256,file_size_bytes,item_count,manifest_json,published_at,created_at)
    VALUES ('package-upgrade','job-upgrade','notice-upgrade',1,'decision.zip','C:\\fixture\\decision.zip',?,20,1,'{}',?,?)`).run('f'.repeat(64), at, at);
  assert.deepEqual(oldDb.prepare('PRAGMA foreign_key_check').all(), []);
  oldDb.close();

  process.env.SSPAT_WORK_DB_PATH = upgradePath;
  const upgraded = databaseStatus();
  assert.ok(upgraded.migrations.some((migration: any) => migration.version === '010_notice_operations_and_projects.sql'));
  assert.ok(upgraded.migrations.some((migration: any) => migration.version === '011_notice_response_progress.sql'));
  withDatabase((db) => {
    const migrated = db.prepare("SELECT oa_sequence,rejection_sequence FROM notice WHERE id='notice-upgrade'").get() as { oa_sequence: number | null; rejection_sequence: number };
    assert.equal(migrated.oa_sequence, null);
    assert.equal(migrated.rejection_sequence, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM notice_attachment WHERE notice_id='notice-upgrade'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM download_package WHERE notice_id='notice-upgrade'").get() as { n: number }).n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  });
  console.log('Notice download ledger tests passed.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
