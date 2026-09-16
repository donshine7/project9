import { constants,copyFileSync,writeFileSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { analysisStatus } from '../lib/analysis';
import { createBackup,withDatabase } from '../lib/work-db';
import { captureVerifiedMail } from '../lib/wiki';
import { hasExactMatterReference,matterReferenceTokens } from '../lib/matter-number';
const [mode,output,...runIds]=process.argv.slice(2);
if(!['dry-run','apply'].includes(mode)||!output||!runIds.length)throw new Error('Usage: dry-run|apply new-report.json verifiedSourceRuns...');
const backup=createBackup();let clone:string|null=null;
if(mode==='dry-run'){clone=path.join(path.dirname(path.resolve(output)),`scope-dry-run-${randomUUID()}.db`);copyFileSync(backup.file,clone,constants.COPYFILE_EXCL);process.env.SSPAT_WORK_DB_PATH=clone;}
const tables=['mail_item','matter','work_item','assignment','action_item','organization','person','matter_group','matter_group_member','matter_party','user_feedback'];
const digest=()=>withDatabase(db=>Object.fromEntries(tables.map(t=>[t,createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).digest('hex')])));
const before=digest(),captured=[],held=[];
for(const c of analysisStatus().candidates.filter(c=>runIds.includes(c.run_id)&&c.kind==='fact')){
  if(!c.verifications.length||c.verifications.some((v:{value:string})=>v.value!=='confirmed')){held.push({id:c.id,reason:'verification'});continue;}
  const summary=String(c.payload.fields.summary.value),refs=[...new Set(matterReferenceTokens(summary))];
  if(refs.length!==1){held.push({id:c.id,reason:'single_reference_required'});continue;}
  const targets=withDatabase(db=>db.prepare('SELECT m.id,m.our_ref,mail.subject FROM mail_matter_link l JOIN matter m ON m.id=l.matter_id JOIN mail_item mail ON mail.id=l.mail_id WHERE l.mail_id=? AND m.archived_at IS NULL').all(c.entity_id)) as {id:string;our_ref:string;subject:string}[];
  const matches=targets.filter(t=>hasExactMatterReference(t.subject,t.our_ref)&&hasExactMatterReference(summary,t.our_ref));
  if(matches.length!==1){held.push({id:c.id,reason:'exact_title_link_required'});continue;}
  captured.push({candidateId:c.id,ref:matches[0].our_ref,...captureVerifiedMail(c.id,matches[0].id)});
}
if(JSON.stringify(before)!==JSON.stringify(digest()))throw new Error('Protected data changed');
const integrity=withDatabase(db=>({check:db.prepare('PRAGMA integrity_check').get(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all()}));
if(JSON.stringify(integrity.check)!=='{"integrity_check":"ok"}'||integrity.foreignKeys.length)throw new Error('Integrity failed');
writeFileSync(output,JSON.stringify({mode,backup:backup.file,clone,captured,held,integrity},null,2),{flag:'wx'});
console.log(JSON.stringify({mode,output,created:captured.filter(c=>!c.duplicate).length,duplicates:captured.filter(c=>c.duplicate).length,held:held.length,integrity}));
