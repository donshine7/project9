import { constants,copyFileSync,readFileSync,writeFileSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import path from 'node:path';
import { createBackup,withDatabase } from '../lib/work-db';
import { ingestWiki,reviewWiki } from '../lib/wiki';
const [mode,input,output]=process.argv.slice(2);
if(!['dry-run','apply'].includes(mode)||!input||!output)throw new Error('Usage: dry-run|apply results.json new-report.json');
const backup=createBackup();let clone:string|null=null;
if(mode==='dry-run'){clone=path.join(path.dirname(path.resolve(output)),`wiki-dry-run-${randomUUID()}.db`);copyFileSync(backup.file,clone,constants.COPYFILE_EXCL);process.env.SSPAT_WORK_DB_PATH=clone;}
const tables=['mail_item','matter','work_item','assignment','action_item','organization','person','matter_group','matter_group_member','matter_party','user_feedback'];
const digest=()=>withDatabase(db=>Object.fromEntries(tables.map(t=>[t,createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).digest('hex')])));
const before=digest(),results=JSON.parse(readFileSync(input,'utf8')),published=[],held=[];
for(const result of results){
  ingestWiki(result);
  try { published.push(reviewWiki(result.runId,'publish',1,'Codex')); }
  catch(error) { if(!String(error).includes('최신 입력으로 재생성'))throw error;held.push({runId:result.runId,reason:String(error)}); }
}
if(JSON.stringify(before)!==JSON.stringify(digest()))throw new Error('Protected business/feedback records changed');
const integrity=withDatabase(db=>({check:db.prepare('PRAGMA integrity_check').get(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all()}));
if(JSON.stringify(integrity.check)!=='{"integrity_check":"ok"}'||integrity.foreignKeys.length)throw new Error('Integrity failed');
writeFileSync(output,JSON.stringify({mode,backup:backup.file,clone,published,held,integrity,protectedTablesUnchanged:true},null,2),{flag:'wx'});
console.log(JSON.stringify({mode,output,published:published.length,held,integrity}));
