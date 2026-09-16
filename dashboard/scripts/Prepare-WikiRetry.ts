import { readFileSync,writeFileSync } from 'node:fs';
import { retryRun,wikiPacket,reviewWiki } from '../lib/wiki';
const [report,output]=process.argv.slice(2);
const held=JSON.parse(readFileSync(report,'utf8')).held as {runId:string}[];
const jobs=held.map(item=>{
  const run=retryRun(item.runId),packet=wikiPacket(run.runId),target=packet.context.wiki;
  reviewWiki(item.runId,'reject',1,'Codex');
  return {...run,type:target.type,id:target.id,label:target.entity.name||target.entity.our_ref,packet};
});
writeFileSync(output,JSON.stringify(jobs,null,2),{flag:'wx'});
console.log(JSON.stringify({output,jobs:jobs.map(({packet: _packet,...job})=>job)}));
