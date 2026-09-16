import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { analysisMailIndex, analysisPacket, analysisStatus, prepareAnalysis, reviewCandidate } from '../lib/analysis';
import { createBackup, importOutlookMail, withDatabase } from '../lib/work-db';
import { auditMailLinks } from '../lib/link-audit';
import { auditRelationshipCoverage } from '../lib/relationship-audit';
import { captureAcceptedRelationshipEntries } from '../lib/wiki';

// Main-task bridge. Specialist agents do not call this mutation tool.
const [command, directory, ...args] = process.argv.slice(2);
if (!directory) throw new Error('Usage: import|prepare|apply|audit PRIVATE_DIRECTORY arguments...');
const root = path.resolve(directory);
mkdirSync(root, { recursive: true });
const read = (name:string) => JSON.parse(readFileSync(path.join(root,name),'utf8').replace(/^\uFEFF/,''));
const save = (name:string,data:unknown) => writeFileSync(path.join(root,name),JSON.stringify(data,null,2),{flag:'wx'});
const hash = (x:unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const integrity = () => withDatabase(db=>({check:db.prepare('PRAGMA integrity_check').get(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all()}));
function requireIntegrity() { const result=integrity(); if(JSON.stringify(result.check)!=='{"integrity_check":"ok"}' || result.foreignKeys.length) throw Error('Integrity failed'); return result; }
const protectedTables=['work_item','assignment','action_item','matter_note','organization','person','matter_group','matter_group_member','matter_party','user_feedback'];
const protectedState=()=>withDatabase(db=>Object.fromEntries(protectedTables.map(t=>[t,hash(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())])));
const counts=()=>withDatabase(db=>Object.fromEntries(['mail_item','matter','mail_matter_link','matter_party','action_item','entity_wiki_revision'].map(t=>[t,db.prepare(`SELECT count(*) n FROM ${t}`).get()])));

if(command==='import') {
  const packet=read('mail-export.json');
  if(packet.truncated || !Array.isArray(packet.records) || !packet.folders.some((f:string)=>f.includes('보낸 편지함'))) throw Error('Incomplete export');
  const excluded=/(대한변리사회|결재|해외 출원 자동 안내|과제 자동 안내)/;
  if(packet.folders.some((f:string)=>excluded.test(f)) || packet.records.some((r:{folderPath:string})=>excluded.test(r.folderPath))) throw Error('Excluded folder present');
  const from=Date.parse(packet.from),to=Date.parse(packet.to);
  if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||packet.records.some((r:{mailAt:string})=>Date.parse(r.mailAt)<from||Date.parse(r.mailAt)>=to)) throw Error('Range mismatch');
  const backup=createBackup(), original=process.env.SSPAT_WORK_DB_PATH;
  const baseline=counts(), before=protectedState();
  const oldMailIds=analysisMailIndex().map(m=>String(m.id));
  const clone=path.join(root,`import-dry-run-${randomUUID()}.db`);
  copyFileSync(backup.file,clone,constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH=clone;
  const range={from:packet.from,to:packet.to,folders:packet.folders};
  const dryRun=importOutlookMail(packet.records,range), dryIntegrity=requireIntegrity();
  if(hash(before)!==hash(protectedState()))throw Error('Protected data changed in dry-run');
  if(original===undefined)delete process.env.SSPAT_WORK_DB_PATH;else process.env.SSPAT_WORK_DB_PATH=original;
  const applied=importOutlookMail(packet.records,range), appliedIntegrity=requireIntegrity();
  if(hash(before)!==hash(protectedState()))throw Error('Protected data changed');
  const replay=importOutlookMail(packet.records,range);
  if(replay.imported!==0||replay.linked!==0)throw Error('Replay not idempotent');
  const newMailIds=analysisMailIndex().map(m=>String(m.id)).filter(id=>!oldMailIds.includes(id));
  const report={backup:backup.file,clone,baseline,after:counts(),dryRun,applied,replay,newMailIds,from:packet.from,to:packet.to,folders:packet.folders,excludedFolders:packet.excludedFolders,dryIntegrity,appliedIntegrity,protectedDataUnchanged:true};
  save('import-report.json',report); console.log(JSON.stringify({...report,newMailIds:newMailIds.length}));
} else if(command==='prepare') {
  const [operation,name,scope='new',size='40']=args;
  const mailIds=scope==='all'?analysisMailIndex().map(m=>String(m.id)):read('import-report.json').newMailIds;
  const jobs=[];
  for(let offset=0;offset<mailIds.length;offset+=Number(size)) {
    const run=prepareAnalysis(operation,mailIds.slice(offset,offset+Number(size))), packet=analysisPacket(run.runId);
    const file: string=`${name}-${jobs.length+1}.json`;
    save(file,packet);
    // Smaller transport view; original immutable packet remains available.
    const context={...packet.context,candidates:packet.context.candidates.filter((c:{kind:string;review_status:string})=>c.kind==='action'&&c.review_status==='accepted')};
    const view: string=`${name}-${jobs.length+1}-view.json`;
    save(view,{...packet,context,fullPacket:path.join(root,file)});
    jobs.push({...run,file:path.join(root,file),view:path.join(root,view)});
  }
  save(`${name}-manifest.json`,jobs);console.log(JSON.stringify(jobs));
} else if(command==='audit') {
  const numberAudit=auditMailLinks(), relationships=auditRelationshipCoverage(),status=analysisStatus();
  save(args[0]||'audit.json',{numberAudit,relationships,groups:status.groupReview,counts:counts()});
  console.log(JSON.stringify({numberAudit:{runId:numberAudit.runId,mailCount:numberAudit.mailCount,findings:numberAudit.findings.length},relationships:{runId:relationships.runId,findings:relationships.findingCount},groupFindings:status.groupReview?.findings?.length,report:args[0]||'audit.json'}));
} else if(command==='apply') {
  const [mode,output,...runIds]=args;
  if(!['dry-run','apply'].includes(mode)||!output||!runIds.length)throw Error('apply dry-run|apply OUTPUT RUN_IDS...');
  const backup=createBackup();let clone:string|null=null;
  if(mode==='dry-run'){clone=path.join(root,`candidate-dry-run-${randomUUID()}.db`);copyFileSync(backup.file,clone,constants.COPYFILE_EXCL);process.env.SSPAT_WORK_DB_PATH=clone;}
  const unchangedTables=['matter','work_item','assignment','matter_note','matter_group','matter_group_member'];
  const existingActions=withDatabase(db=>db.prepare('SELECT * FROM action_item ORDER BY id').all()) as Array<{id:string}>;
  const preserved=()=>withDatabase(db=>({tables:Object.fromEntries(unchangedTables.map(t=>[t,hash(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())])),actions:existingActions.map(a=>db.prepare('SELECT * FROM action_item WHERE id=?').get(a.id))}));
  const preservedBefore=hash(preserved());
  const accepted=[],held=[];
  for(const c of analysisStatus().candidates.filter(c=>runIds.includes(c.run_id)&&['fact','link','action'].includes(c.kind))) {
    if(c.review_status!=='pending'||!c.verifications.length||c.verifications.some((v:{value:string})=>v.value!=='confirmed')){held.push({id:c.id,reason:'not_pending_or_not_independently_confirmed'});continue;}
    try { accepted.push(reviewCandidate(c.id,{action:'accept',expectedVersion:c.row_version,reason:'2026-09-15 사용자의 전체 단계 진행 승인. 원문·독립 검증·최신 버전·중복 보호를 통과한 후보만 반영.'})); }
    catch(error) { if(!(error instanceof Error)||!/(재분석|이미|최신|중복|충돌)/.test(error.message))throw error;held.push({id:c.id,reason:error.message}); }
  }
  const relationshipEntries=captureAcceptedRelationshipEntries();
  if(preservedBefore!==hash(preserved()))throw Error('Existing business records changed; stop and inspect backup');
  const report={mode,backup:backup.file,clone,accepted,held,relationshipEntries,existingBusinessRecordsUnchanged:true,integrity:requireIntegrity()};
  save(output,report);console.log(JSON.stringify({...report,accepted:accepted.length}));
} else throw Error('Unknown command');
