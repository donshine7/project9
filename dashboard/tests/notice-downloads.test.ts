import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMatter, databaseStatus, withDatabase } from '../lib/work-db';
import { createNoticeProject, getDownloadNotice, getDownloadSummary, linkExistingNoticeProject, listDownloadNotices, previewNoticeProject, requestJobResume, requestNoticeOperation } from '../lib/notice-downloads';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-notice-downloads-'));
const databasePath = path.join(temporaryRoot, 'sspat-work.db');
const projectRoot = path.join(temporaryRoot, 'projects');
process.env.SSPAT_WORK_DB_PATH = databasePath;
process.env.SSPAT_NOTICE_PROJECT_ROOT = projectRoot;
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

function sha256(filePath: string) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function createVerifiedPackage(matterReference = 'P261252') {
  const source = path.join(temporaryRoot, `package-source-${matterReference}`);
  mkdirSync(source, { recursive: true });
  const fileName = `${matterReference}_의견제출통지서.pdf`;
  const bytes = Buffer.from('%PDF-1.4\nverified fixture\n', 'utf8');
  writeFileSync(path.join(source, fileName), bytes);
  const manifest = {
    schemaVersion: 1,
    matterReference,
    noticeKind: 'opinion_submission',
    oaSequence: 1,
    noticeDate: '2026-06-25',
    dueDate: '2026-10-25',
    itemCount: 1,
    items: [{ archiveEntry: fileName, fileSizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }],
  };
  writeFileSync(path.join(source, 'download-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const zipPath = path.join(temporaryRoot, `[${matterReference}] 1OA (2026-06-25)(2026-10-25).zip`);
  const zipScript = path.join(temporaryRoot, 'create-test-zip.ps1');
  writeFileSync(zipScript, "param([string]$Source,[string]$Destination)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n[System.IO.Compression.ZipFile]::CreateFromDirectory($Source,$Destination,[System.IO.Compression.CompressionLevel]::Optimal,$false)\n", 'utf8');
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', zipScript, '-Source', source, '-Destination', zipPath], { windowsHide: true });
  return { zipPath, fileName };
}

async function main() {
  try {
    mkdirSync(path.join(projectRoot, '_sample_case_project', '00_inbox'), { recursive: true });
    for (const folder of ['10_source', '20_extracted', '30_analysis', '40_strategy', '50_drafts', '60_review', '90_final', '99_logs']) mkdirSync(path.join(projectRoot, '_sample_case_project', folder), { recursive: true });
    mkdirSync(path.join(projectRoot, '_shared'), { recursive: true });
    writeFileSync(path.join(projectRoot, '_sample_case_project', 'case.yaml'), 'case_id: null\nproject_name: null\nclient: null\noffice_action_date: null\nresponse_deadline: null\nstatus: new\n', 'utf8');

    const status = databaseStatus();
    assert.ok(status.migrations.some((migration: any) => migration.version === '010_notice_operations_and_projects.sql'));
    const tables = withDatabase((db) => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)));
    for (const table of ['notice_detection_run', 'notice_pipeline_event', 'notice_operator_request', 'notice_project_link', 'notice_project_stage', 'notice_project_event']) assert.ok(tables.has(table), `${table} should exist`);

    const created = createMatter({ ourRef: 'P261252', workType: '중간사건', stage: '중간사건', currentStatus: '의견통지' });
    const matterId = String(created.matter.id);
    const { zipPath, fileName } = createVerifiedPackage();
    const at = new Date().toISOString();
    withDatabase((db) => {
      db.prepare(`INSERT INTO notice(id,notice_key,matter_id,matter_reference,notice_kind,identity_basis,progress_sequence,notice_date,due_date,oa_sequence,status,created_at,updated_at)
        VALUES ('notice-oa','notice_${'a'.repeat(64)}',?,'P261252','opinion_submission','progress_sequence_and_notice_date','1','2026-06-25','2026-10-25',1,'published',?,?)`).run(matterId, at, at);
      db.prepare(`INSERT INTO notice_attachment(id,notice_id,attachment_version,source_position,document_name,file_name,file_size_bytes,sha256,state,created_at,updated_at)
        VALUES ('attachment-1','notice-oa',1,1,'의견제출통지서',?,24,?,'verified',?,?)`).run(fileName, 'b'.repeat(64), at, at);
      db.prepare(`INSERT INTO download_job(id,notice_id,attachment_version,package_version,expected_file_name,status,requested_at,started_at,completed_at,updated_at)
        VALUES ('job-published','notice-oa',1,1,?,'published',?,?,?,?)`).run(path.basename(zipPath), at, at, at, at);
      db.prepare(`INSERT INTO download_package(id,download_job_id,notice_id,package_version,file_name,destination_path,sha256,file_size_bytes,item_count,manifest_json,published_at,created_at)
        VALUES ('package-1','job-published','notice-oa',1,?,?,?,?,1,'{}',?,?)`).run(path.basename(zipPath), zipPath, sha256(zipPath), readFileSync(zipPath).length, at, at);
    });

    const summary = getDownloadSummary();
    assert.equal(summary.counts.total, 1);
    assert.equal(summary.counts.publishedToday, 1);
    assert.equal(summary.automation.schedulerEnabled, false);
    const listed = listDownloadNotices({ q: 'P261252' });
    assert.equal(listed.total, 1);
    assert.equal(listed.notices[0].rowVersion, 1);
    const detail = getDownloadNotice('notice-oa');
    assert.equal(detail.notice.package?.itemCount, 1);

    const preview = await previewNoticeProject('notice-oa', { clientLabel: '(주) 이문원바이오' });
    assert.equal(preview.projectName, 'P261252_(주)이문원바이오_1OA');
    assert.ok(preview.destination.startsWith(projectRoot));
    const project = await createNoticeProject('notice-oa', { previewToken: preview.previewToken });
    assert.equal(project.status, 'created');
    assert.equal(readFileSync(path.join(project.path, '10_source', fileName), 'utf8'), '%PDF-1.4\nverified fixture\n');
    assert.match(readFileSync(path.join(project.path, 'case.yaml'), 'utf8'), /source_package_sha256:/);
    assert.match(readFileSync(path.join(project.path, 'STATUS.md'), 'utf8'), /1OA/);
    await assert.rejects(() => previewNoticeProject('notice-oa', { clientLabel: '(주) 이문원바이오' }), (error: any) => error?.code === 'PROJECT_DESTINATION_EXISTS' || error?.code === 'NOTICE_PROJECT_ALREADY_LINKED');

    const linkedMatter = createMatter({ ourRef: 'P261253', workType: '중간사건', stage: '중간사건', currentStatus: '의견통지' });
    const linkedPackage = createVerifiedPackage('P261253');
    const existingName = 'P261253_기존회사_1OA', existingPath = path.join(projectRoot, existingName);
    for (const folder of ['10_source', '30_analysis', '40_strategy', '50_drafts', '60_review', '90_final']) mkdirSync(path.join(existingPath, folder), { recursive: true });
    writeFileSync(path.join(existingPath, 'case.yaml'), `case_id: "P261253"\nproject_name: "${existingName}"\noffice_action_date: "2026-06-25"\nstatus: "drafting"\n`, 'utf8');
    withDatabase((db) => {
      db.prepare(`INSERT INTO notice(id,notice_key,matter_id,matter_reference,notice_kind,identity_basis,progress_sequence,notice_date,due_date,oa_sequence,status,created_at,updated_at)
        VALUES ('notice-existing','notice_${'9'.repeat(64)}',?,'P261253','opinion_submission','progress_sequence_and_notice_date','2','2026-06-25','2026-10-25',1,'published',?,?)`).run(String(linkedMatter.matter.id), at, at);
      db.prepare(`INSERT INTO download_job(id,notice_id,attachment_version,package_version,expected_file_name,status,requested_at,completed_at,updated_at)
        VALUES ('job-existing','notice-existing',1,1,?,'published',?,?,?)`).run(path.basename(linkedPackage.zipPath), at, at, at);
      db.prepare(`INSERT INTO download_package(id,download_job_id,notice_id,package_version,file_name,destination_path,sha256,file_size_bytes,item_count,manifest_json,published_at,created_at)
        VALUES ('package-existing','job-existing','notice-existing',1,?,?,?,?,1,'{}',?,?)`).run(path.basename(linkedPackage.zipPath), linkedPackage.zipPath, sha256(linkedPackage.zipPath), readFileSync(linkedPackage.zipPath).length, at, at);
    });
    const existingPreview = await previewNoticeProject('notice-existing', { clientLabel: '기존회사' });
    assert.equal(existingPreview.existingProject, true);
    const linked = await linkExistingNoticeProject('notice-existing', { previewToken: existingPreview.previewToken });
    assert.equal(linked.status, 'linked_existing');
    assert.equal(linked.currentStage, 'drafting');
    assert.equal(linked.userActionCode, null);

    withDatabase((db) => {
      db.prepare("UPDATE notice SET status='held',row_version=row_version+1 WHERE id='notice-oa'").run();
      db.prepare("INSERT INTO download_job(id,notice_id,attachment_version,package_version,expected_file_name,status,requested_at,updated_at) VALUES ('job-failed','notice-oa',1,2,'retry.zip','failed',?,?)").run(at, at);
    });
    const held = getDownloadNotice('notice-oa').notice;
    const recheck = requestNoticeOperation('notice-oa', 'recheck', { expectedVersion: held.rowVersion });
    assert.equal(recheck.status, 'pending');
    const resume = requestJobResume('job-failed', { expectedVersion: held.rowVersion });
    assert.equal(resume.jobId, 'job-failed');
    assert.throws(() => requestJobResume('job-failed', { expectedVersion: held.rowVersion }), (error: any) => error?.code === 'NOTICE_REQUEST_DUPLICATE');

    console.log('Notice download operations tests passed.');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

void main();
