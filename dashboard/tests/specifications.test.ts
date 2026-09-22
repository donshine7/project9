import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  confirmSpecificationSetupStep,
  createSpecificationSetup,
  getSpecificationProject,
  getSpecificationSummary,
  initializeSpecificationSetup,
  listSpecificationProjects,
  previewSpecificationSetup,
  runSpecificationCheck,
  verifySpecificationSetup,
} from '../lib/specification-projects';
import { databaseStatus } from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-specifications-'));
const projectRoot = path.join(temporaryRoot, '한국특허명세서작성');
const databasePath = path.join(temporaryRoot, 'sspat-work.db');
const harness = path.join(projectRoot, '_shared', 'scripts', 'harness.py');
process.env.SSPAT_WORK_DB_PATH = databasePath;
process.env.SSPAT_SPEC_PROJECT_ROOT = projectRoot;
process.env.SSPAT_SPEC_HARNESS_PATH = harness;
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

function digest(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function templateCase() {
  return {
    schema_version: '1.0.0', is_template: true, case_id: null, project_name: null, service_type: null,
    invention_type: null, creation_direction: null, stage: 'intake', status: 'planned', owner: null,
    shared_version: '1.0.0', inputs: [], shared_baseline: [], latest_outputs: [],
    review: { self: 'not_performed', independent: 'not_performed', render: 'not_performed' }, approvals: [],
    unresolved_items: [], next_action: '발명 자료를 정리한다.', updated_at: null,
  };
}

async function main() {
  try {
    for (const folder of ['_shared/scripts', '프로젝트폴더샘플/10_source_original', '프로젝트폴더샘플/20_prior_art', '프로젝트폴더샘플/30_analysis', '프로젝트폴더샘플/40_draft', '프로젝트폴더샘플/50_review', '프로젝트폴더샘플/60_filing', '프로젝트폴더샘플/99_logs', '프로젝트폴더샘플/outputs']) mkdirSync(path.join(projectRoot, ...folder.split('/')), { recursive: true });
    writeFileSync(path.join(projectRoot, '프로젝트폴더샘플', 'case.yaml'), `${JSON.stringify(templateCase(), null, 2)}\n`, 'utf8');
    writeFileSync(path.join(projectRoot, '프로젝트폴더샘플', '10_source_original', 'README.md'), '# 원본\n', 'utf8');
    writeFileSync(harness, `
import argparse, json, pathlib, shutil, sys
p=argparse.ArgumentParser(); s=p.add_subparsers(dest='cmd', required=True)
i=s.add_parser('init'); i.add_argument('--root'); i.add_argument('--name'); i.add_argument('--case-id'); i.add_argument('--service-type'); i.add_argument('--direction'); i.add_argument('--apply',action='store_true')
c=s.add_parser('check'); c.add_argument('--case'); c.add_argument('--stage'); c.add_argument('--shared')
a=p.parse_args()
if a.cmd=='check': print(json.dumps({'ok':True,'errors':[],'scope':'test'})); sys.exit(0)
root=pathlib.Path(a.root); src=root/'프로젝트폴더샘플'; dst=root/a.name
if dst.exists(): print(json.dumps({'ok':False,'error':'exists'})); sys.exit(1)
result={'mode':'apply' if a.apply else 'dry-run','destination':str(dst),'files':[str(x.relative_to(src)) for x in src.rglob('*') if x.is_file()]}
if a.apply:
 shutil.copytree(src,dst); data=json.loads((dst/'case.yaml').read_text(encoding='utf8')); data.update(is_template=False,case_id=a.case_id,project_name=a.name,service_type=a.service_type,creation_direction=a.direction); (dst/'case.yaml').write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\\n',encoding='utf8')
print(json.dumps(result,ensure_ascii=False))
`, 'utf8');

    const legacy = path.join(projectRoot, 'P260001_기존사건');
    mkdirSync(path.join(legacy, '10_source_original'), { recursive: true });
    mkdirSync(path.join(legacy, '40_draft'), { recursive: true });
    mkdirSync(path.join(legacy, 'outputs'), { recursive: true });
    writeFileSync(path.join(legacy, 'PROJECT.md'), '# 기존 사건\n', 'utf8');
    const legacyHash = digest(path.join(legacy, 'PROJECT.md'));

    assert.ok(databaseStatus().migrations.some((migration: any) => migration.version === '012_specification_projects.sql'));
    await assert.rejects(async () => createSpecificationSetup({ caseId: 'P262100', clientLabel: '회사', projectName: '../outside', serviceType: '메이킹', inventionType: '방법', creationDirection: '흐름 창작', owner: '장진태' }), (error: any) => error?.code === 'SPEC_INVALID_PROJECT_NAME');

    let setupResult = createSpecificationSetup({ caseId: 'P262100-S1', clientLabel: '테스트회사', projectName: 'P262100-S1_테스트회사', serviceType: '메이킹', inventionType: '방법', creationDirection: '센서 입력을 순차 처리하는 방향', owner: '장진태' });
    assert.equal(setupResult.steps[0].status, 'confirmed');
    const preview = await previewSpecificationSetup(setupResult.setup.id);
    assert.equal(preview.preview.mode, 'dry-run');
    assert.ok(preview.preview.files.includes('case.yaml'));
    const initialized = await initializeSpecificationSetup(setupResult.setup.id, { previewToken: preview.preview.previewToken });
    assert.equal(initialized.setup.status, 'created');
    const newProject = initialized.project;
    assert.equal(newProject.case?.invention_type, '방법');
    assert.equal(newProject.case?.owner, '장진태');

    await confirmSpecificationSetupStep(setupResult.setup.id, { stepKey: 'codex_setup', evidence: '기본 폴더와 _shared 추가 폴더 설정 확인' });
    await assert.rejects(() => confirmSpecificationSetupStep(setupResult.setup.id, { stepKey: 'source_materials', evidence: '자료 배치' }), (error: any) => error?.code === 'SPEC_SOURCE_MISSING');
    writeFileSync(path.join(projectRoot, 'P262100-S1_테스트회사', '10_source_original', '발명자료.txt'), '원본', 'utf8');
    await confirmSpecificationSetupStep(setupResult.setup.id, { stepKey: 'source_materials', evidence: '발명자료.txt 확인' });
    setupResult = await verifySpecificationSetup(setupResult.setup.id, { taskTitle: '[CASE] P262100-S1 - 발명 자료 접수', externalTaskId: 'task-1' });
    assert.equal(setupResult.setup.status, 'ready');

    const list = await listSpecificationProjects();
    assert.equal(list.projects.length, 2);
    const legacyProject = list.projects.find((item) => item.name === 'P260001_기존사건')!;
    assert.equal(legacyProject.compatibility, 'legacy_unlinked');
    await getSpecificationProject(legacyProject.id);
    await assert.rejects(() => runSpecificationCheck(legacyProject.id), (error: any) => error?.code === 'SPEC_PROJECT_UNLINKED');
    assert.equal(digest(path.join(legacy, 'PROJECT.md')), legacyHash, 'legacy files must remain unchanged');

    const created = list.projects.find((item) => item.name === 'P262100-S1_테스트회사')!;
    const check = await runSpecificationCheck(created.id);
    assert.equal(check.status, 'passed');
    const summary = await getSpecificationSummary();
    assert.equal(summary.total, 2);
    assert.equal(summary.held, 1);
    console.log('Specification project workflow tests passed.');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

void main();
