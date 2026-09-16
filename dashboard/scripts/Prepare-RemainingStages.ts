import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisMailIndex, analysisPacket, analysisStatus, prepareAnalysis } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';

const output = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('New private directory required');
mkdirSync(output);
const save = (name:string,data:unknown) => writeFileSync(path.join(output,name),JSON.stringify(data,null,2),{flag:'wx'});
const backup = createBackup();
const status = analysisStatus();
const facts = status.candidates.filter(c=>c.kind==='fact');
const latest = facts.filter((c,i)=>facts.findIndex(x=>x.entity_id===c.entity_id)===i);
const rewrite = latest.filter(c=>c.verifications.some((v:{value:string})=>v.value!=='confirmed'));
const allMailIds = analysisMailIndex().map(m=>String(m.id));
function prepare(operation:string,mailIds:string[],name:string,extra:unknown) {
  const run = prepareAnalysis(operation,mailIds);
  save(`${name}.json`,{...analysisPacket(run.runId),taskScope:extra});
  return {...run,packet:path.join(output,`${name}.json`)};
}
const manifest = {
  backup:backup.file,
  rewrite:prepare('mail_fact_extraction',rewrite.map(c=>String(c.entity_id)),'rewrite',{targetIds:rewrite.map(c=>c.id),purpose:'현재 회신 중심 재작성, 상충 날짜는 두 값을 함께 기재하며 기한 확정 금지'}),
  relationships:prepare('matter_linking',allMailIds,'relationships',{audit:status.relationshipAudit,numberAudit:status.linkAudit,groups:status.groupReview}),
  actions:prepare('action_judgement',allMailIds,'actions',{currentTime:new Date().toISOString(),oldCandidates:status.candidates.filter(c=>c.kind==='action'),purpose:'전체 저장 메일·보낸 회신·현재 업무와 비교한 최신 Action 후보. 현재 완료 추정 금지. 이미 지난 요청기한은 과거 요청기한임을 명시.'}),
};
save('manifest.json',manifest);
save('baseline.json',withDatabase(db=>({feedback:db.prepare('SELECT f.*,d.field_path,d.decision_run_id FROM user_feedback f LEFT JOIN decision_item d ON d.id=f.decision_item_id').all(),comparison:db.prepare('SELECT * FROM decision_comparison').all(),groups:db.prepare('SELECT g.*,group_concat(m.our_ref) members FROM matter_group g LEFT JOIN matter_group_member gm ON gm.group_id=g.id LEFT JOIN matter m ON m.id=gm.matter_id GROUP BY g.id').all()})));
console.log(JSON.stringify(manifest,null,2));
