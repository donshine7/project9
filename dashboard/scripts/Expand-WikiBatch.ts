import { readFileSync,writeFileSync } from 'node:fs';
const [compactPath,output,...packets]=process.argv.slice(2);
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const jobs=packets.flatMap(read);
const titles:Record<string,string>={overview:'현재 요약',timeline:'날짜별 중요내용',issues:'확인할 사항'};
type Sentence=[string,string|null,string[]];
type Compact=[string,string,Array<[string,Sentence[]]>];
const seen=new Set();
const results=(read(compactPath) as Compact[]).map(([prefix,changeSummary,sections])=>{
  const matches=jobs.filter(j=>j.runId.startsWith(prefix));
  if(matches.length!==1||seen.has(matches[0].runId))throw new Error(`Run ${prefix}`);
  const job=matches[0];seen.add(job.runId);
  return {schemaVersion:1,runId:job.runId,changeSummary,sections:sections.map(([key,sentences])=>({key,title:titles[key],sentences:sentences.map(([text,entryDate,prefixes])=>({text,entryDate:key==='timeline'?entryDate:null,eventIds:prefixes.map(p=>{
    const entries=job.packet.context.wiki.entries.filter((e:{event_id:string})=>e.event_id.startsWith(p));
    if(entries.length!==1)throw new Error(`Event ${p}`);
    if(key==='timeline'&&entries[0].entry_date!==entryDate)throw new Error('Date mismatch');
    return entries[0].event_id;
  })}))}))};
});
if(results.length!==jobs.length)throw new Error('Incomplete wiki coverage');
writeFileSync(output,JSON.stringify(results,null,2),{flag:'wx'});
console.log(JSON.stringify({output,count:results.length}));
