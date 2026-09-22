import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMatter, databaseStatus, withDatabase } from '../lib/work-db';
import { completeResponseStage, getResponseProject, getResponseSummary, linkResponseTask, listResponseProjects, reconcileResponseProject, recordResponseApproval } from '../lib/notice-response-projects';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-notice-responses-'));
const databasePath = path.join(temporaryRoot, 'sspat-work.db');
const projectRoot = path.join(temporaryRoot, 'projects');
const projectName = 'P261252_이문원바이오_1OA';
const projectPath = path.join(projectRoot, projectName);
process.env.SSPAT_WORK_DB_PATH = databasePath;
process.env.SSPAT_NOTICE_PROJECT_ROOT = projectRoot;
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

function version() {
  return getResponseProject('notice-response').response.rowVersion;
}

function write(relative: string, content: string) {
  const target = path.join(projectPath, ...relative.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return relative;
}

async function main() {
  try {
    const status = databaseStatus();
    assert.ok(status.migrations.some((migration: any) => migration.version === '011_notice_response_progress.sql'));
    const tables = withDatabase((db) => new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name)));
    for (const table of ['notice_project_artifact', 'notice_project_approval', 'notice_project_task_link']) assert.ok(tables.has(table), `${table} should exist`);

    for (const folder of ['00_inbox', '10_source', '20_extracted', '30_analysis', '40_strategy', '50_drafts', '60_review', '90_final', '99_logs']) mkdirSync(path.join(projectPath, folder), { recursive: true });
    writeFileSync(path.join(projectPath, 'case.yaml'), `case_id: "P261252"\nproject_name: "${projectName}"\nclient: "이문원바이오"\noffice_action_date: "2026-06-25"\nresponse_deadline: "2026-10-25"\nstatus: intake\nworkflow:\n  current_stage: project_created\n  stage_number: 3\n  user_action_required: true\n  user_action_code: "connect_codex_project"\n  action_summary: "접수 작업을 연결하세요."\n`, 'utf8');
    writeFileSync(path.join(projectPath, 'STATUS.md'), '# 사건 상태\n\n- 현재 단계: 03/13 Codex 프로젝트·접수 작업 연결\n- 사용자 작업: 접수 작업을 연결하세요.\n- 마지막 갱신: 2026-09-21T00:00:00.000Z\n', 'utf8');
    const matter = createMatter({ ourRef: 'P261252', workType: '중간사건', stage: '중간사건', currentStatus: '의견통지' });
    const at = '2026-09-21T00:00:00.000Z', packagePath = path.join(temporaryRoot, 'notice.zip');
    writeFileSync(packagePath, 'verified package', 'utf8');
    withDatabase((db) => {
      db.prepare(`INSERT INTO notice(id,notice_key,matter_id,matter_reference,notice_kind,identity_basis,progress_sequence,notice_date,due_date,oa_sequence,status,created_at,updated_at)
        VALUES ('notice-response','notice_${'c'.repeat(64)}',?,'P261252','opinion_submission','progress_sequence_and_notice_date','952026057726988','2026-06-25','2026-10-25',1,'published',?,?)`).run(String(matter.matter.id), at, at);
      db.prepare(`INSERT INTO download_job(id,notice_id,attachment_version,package_version,expected_file_name,status,requested_at,completed_at,updated_at)
        VALUES ('response-job','notice-response',1,1,'[P261252] 1OA (2026-06-25)(2026-10-25).zip','published',?,?,?)`).run(at, at, at);
      db.prepare(`INSERT INTO download_package(id,download_job_id,notice_id,package_version,file_name,destination_path,sha256,file_size_bytes,item_count,manifest_json,published_at,created_at)
        VALUES ('response-package','response-job','notice-response',1,'[P261252] 1OA (2026-06-25)(2026-10-25).zip',?,'${'d'.repeat(64)}',16,3,'{}',?,?)`).run(packagePath, at, at);
      db.prepare(`INSERT INTO notice_project_link(id,notice_id,project_name,project_relative_path,client_label,creation_status,creation_manifest_sha256,source_package_sha256,row_version,created_at,updated_at)
        VALUES ('response-project','notice-response',?,?,?,'created','${'e'.repeat(64)}','${'d'.repeat(64)}',1,?,?)`).run(projectName, projectName, '이문원바이오', at, at);
      db.prepare(`INSERT INTO notice_project_stage(project_id,stage_key,stage_number,status,user_action_code,action_summary,row_version,updated_at)
        VALUES ('response-project','project_created',3,'active','connect_codex_project','접수 작업을 연결하세요.',1,?)`).run(at);
    });

    assert.equal(getResponseSummary().total, 1);
    assert.equal(getResponseSummary().userAction, 1);
    assert.equal(listResponseProjects({ q: 'P261252' }).projects[0].workflow.currentStage, 3);
    assert.equal(getResponseProject('notice-response').response.workflow.stages.length, 13);

    await linkResponseTask('notice-response', { expectedVersion: version(), taskTitle: '[CASE] P261252 - 접수', externalTaskId: 'task-1' });
    assert.equal(getResponseProject('notice-response').response.workflow.currentStage, 4);
    assert.match(readFileSync(path.join(projectPath, 'case.yaml'), 'utf8'), /stage_number: 4/);

    write('20_extracted/intake.md', '# 접수 점검\n');
    await completeResponseStage('notice-response', 4, { expectedVersion: version(), artifactPath: '20_extracted/intake.md', version: 'v1' });
    write('30_analysis/issues.md', '# 거절이유 분석\n');
    await completeResponseStage('notice-response', 5, { expectedVersion: version(), artifactPath: '30_analysis/issues.md', version: 'v1' });
    write('40_strategy/options.md', '# 대응안 A/B\n');
    await completeResponseStage('notice-response', 6, { expectedVersion: version(), artifactPath: '40_strategy/options.md', version: 'v1' });
    assert.equal(getResponseProject('notice-response').response.workflow.currentStage, 7);

    await recordResponseApproval('notice-response', { expectedVersion: version(), approvalKind: 'strategy_selection', targetPath: '40_strategy/options.md', version: 'v1', selection: 'A안 선택' });
    write('50_drafts/opinion_v1.hwpx', 'draft-v1');
    await completeResponseStage('notice-response', 8, { expectedVersion: version(), artifactPath: '50_drafts/opinion_v1.hwpx', version: 'v1' });
    write('60_review/self-review.md', '# 자체검수\n');
    await completeResponseStage('notice-response', 9, { expectedVersion: version(), artifactPath: '60_review/self-review.md', version: 'v1' });
    write('60_review/independent-review.md', '# 독립검수 통과\n');
    await completeResponseStage('notice-response', 10, { expectedVersion: version(), artifactPath: '60_review/independent-review.md', version: 'v1' });
    assert.equal(getResponseProject('notice-response').response.workflow.currentStage, 11);

    const submission = await recordResponseApproval('notice-response', { expectedVersion: version(), approvalKind: 'submission_copy', targetPath: '50_drafts/opinion_v1.hwpx', version: 'v1' });
    assert.equal(submission.promotedPath, '90_final/opinion_v1.hwpx');
    assert.equal(readFileSync(path.join(projectPath, '90_final', 'opinion_v1.hwpx'), 'utf8'), 'draft-v1');
    await recordResponseApproval('notice-response', { expectedVersion: version(), approvalKind: 'external_dispatch', targetPath: '90_final/opinion_v1.hwpx', version: 'v1', submittedAt: '2026-09-21T15:00:00+09:00' });
    write('90_final/filing-receipt.pdf', '%PDF-1.4 receipt');
    await completeResponseStage('notice-response', 13, { expectedVersion: version(), artifactPath: '90_final/filing-receipt.pdf', version: 'v1', submittedAt: '2026-09-21T15:00:00+09:00' });

    let detail = getResponseProject('notice-response');
    assert.equal(detail.response.workflow.completed, true);
    assert.equal(detail.artifacts.length, 11);
    assert.equal(detail.approvals.filter((approval: any) => approval.decision === 'approved').length, 4);
    assert.equal(getResponseSummary().completed, 1);
    const reconciled = await reconcileResponseProject('notice-response', { expectedVersion: version() });
    assert.equal(reconciled.consistent, true);

    writeFileSync(path.join(projectPath, '90_final', 'opinion_v1.hwpx'), 'changed-after-approval', 'utf8');
    const invalidated = await reconcileResponseProject('notice-response', { expectedVersion: version() });
    assert.equal(invalidated.consistent, false);
    assert.equal(invalidated.invalidApprovalCount, 1);
    detail = getResponseProject('notice-response');
    assert.equal(detail.response.workflow.currentStage, 12);
    assert.equal(detail.response.workflow.blocked, true);
    assert.ok(detail.approvals.some((approval: any) => approval.approvalKind === 'external_dispatch' && approval.decision === 'revoked'));

    await assert.rejects(() => completeResponseStage('notice-response', 12, { expectedVersion: version(), artifactPath: '90_final/opinion_v1.hwpx' }), (error: any) => error?.code === 'RESPONSE_STAGE_ACTION_REQUIRED');
    console.log('Notice response workflow tests passed.');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

void main();
