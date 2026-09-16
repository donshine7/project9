import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisMailIndex, analysisPacket, prepareAnalysis } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';
const [directory]=process.argv.slice(2);
if(!directory)throw Error('Usage: new private evaluation directory');
const root=path.resolve(directory), source=process.env.SSPAT_PROJECT_ROOT||path.resolve('..');
mkdirSync(root); // Never overwrite previous evaluation.
const backup=createBackup(), clone=path.join(root,'evaluation.db');
copyFileSync(backup.file,clone,constants.COPYFILE_EXCL);
process.env.SSPAT_WORK_DB_PATH=clone;
const prefixes=['4877e34d','854e8ac3','e0ac2272','bfea53b9','5b994145'];
const mailIds=prefixes.map(p=>{const matches=analysisMailIndex().filter(m=>String(m.id).startsWith(p));if(matches.length!==1)throw Error('Ambiguous evaluation source');return String(matches[0].id);});
const jobs=[];
for(const variant of ['baseline','candidate']){
  const configRoot=path.join(root,variant);
  mkdirSync(path.join(configRoot,'config','agents'),{recursive:true});mkdirSync(path.join(configRoot,'docs'));
  const files=['config/llm-routing.toml','config/analysis-contract.md','docs/WORK_MANAGEMENT_ARCHITECTURE.md',...['mail-intake','matter-linker','action-analyst','risk-verifier','wiki-synthesizer'].map(n=>`config/agents/${n}.toml`)];
  for(const file of files){let content=readFileSync(path.join(source,file),'utf8');if(variant==='candidate'&&file==='config/agents/mail-intake.toml'){const end=content.lastIndexOf('"""');content=content.slice(0,end)+'\n'+readFileSync(path.join(source,'config/evaluation/mail-intake-candidate.md'),'utf8')+'\n'+content.slice(end);}writeFileSync(path.join(configRoot,file),content,{flag:'wx'});}
  process.env.SSPAT_PROJECT_ROOT=configRoot;
  const run=prepareAnalysis('mail_fact_extraction',mailIds),packet=analysisPacket(run.runId);
  const metadata=withDatabase(db=>db.prepare('SELECT s.context_hash FROM decision_run r JOIN input_snapshot s ON s.id=r.input_snapshot_id WHERE r.id=?').get(run.runId)) as {context_hash:string};
  // Any policy activation here is sandbox-local only, explicitly testing.
  withDatabase(db=>db.prepare("UPDATE policy_revision SET status='testing' WHERE id=(SELECT policy_revision_id FROM decision_run WHERE id=?)").run(run.runId));
  const file=path.join(root,`${variant}-packet.json`);writeFileSync(file,JSON.stringify(packet,null,2),{flag:'wx'});
  jobs.push({variant,...run,configRoot,file,contextHash:metadata.context_hash});
}
if(jobs[0].contextHash!==jobs[1].contextHash)throw Error('A/B input mismatch');
writeFileSync(path.join(root,'manifest.json'),JSON.stringify({clone,backup:backup.file,jobs,productionUntouched:true,groundTruthOrigin:'independent_verifier_not_user_feedback',activation:'not_authorized'},null,2),{flag:'wx'});
console.log(JSON.stringify({clone,jobs}));
