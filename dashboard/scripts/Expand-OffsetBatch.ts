import { readFileSync, writeFileSync } from 'node:fs';
// Transport only: resolves agent-provided UTF-16 spans without generating judgments.
const [packetFile, compactFile, output] = process.argv.slice(2);
const read = (file:string) => JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const packet=read(packetFile), compact=read(compactFile);
if(packet.runId!==compact.runId)throw Error('Run mismatch');
type Mail=Record<string,string>;
const resolve=(prefix:string):Mail=>{const found=packet.mails.filter((m:Mail)=>m.id.startsWith(prefix));if(found.length!==1)throw Error(`Ambiguous mail ${prefix}`);return found[0];};
const evidence=(m:Mail, spans:[string,number,number][])=>spans.map(([field,start,end])=>{
  const text=m[field];
  if(typeof text!=='string'||!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<=start||end>text.length||end-start>4000)throw Error(`Invalid span ${m.id}:${field}:${start}-${end}`);
  return {mailId:m.id,field,quote:text.slice(start,end)};
});
const candidates:any[]=[];
if(compact.rows)for(const [prefix,summary,confidence,rationale,spans] of compact.rows){
  const m=resolve(prefix);
  candidates.push({key:`fact-${m.id}`,kind:'fact',entityType:'mail',entityId:m.id,fields:{summary:{value:summary,confidence,rationale,evidence:evidence(m,spans)}}});
}
if(compact.groups)for(const g of compact.groups){
  const m=resolve(g.mail);
  for(const [ref,start,end] of g.refs){
    const ev=evidence(m,[[g.refField||'body_text',start,end]]);
    if(ev[0].quote.trim()!==ref)throw Error(`Reference span mismatch ${ref}: ${ev[0].quote}`);
    const fields:Record<string,unknown>={matterRef:{value:ref,confidence:1,rationale:'원문에 완전한 기존 관리번호가 있다.',evidence:ev}};
    const submittedFields=g.fields || ['partyType','businessType','name','email','role'].map((name,i)=>[name,g.values[i],g.confidences?.[i]??1,compact.fieldRationales[name],g.indexes[i]]);
    for(const [name,value,confidence,rationale,indexes] of submittedFields)fields[name]={value,confidence,rationale,evidence:evidence(m,indexes.map((i:number)=>g.quotes[i]))};
    if(Object.keys(fields).sort().join(',')!=='businessType,email,matterRef,name,partyType,role')throw Error('Six relationship fields required');
    candidates.push({key:`party-${ref}-${g.mail}-${candidates.length}`,kind:'link',entityType:'mail',entityId:m.id,fields});
  }
}
const candidateIds=new Set(candidates.map(c=>c.entityId));
if(compact.rows&&candidateIds.size!==candidates.length)throw Error('Duplicate fact mail');
const review=new Map<string,string>((compact.needsReview||[]).map((row:string|[string,string])=>typeof row==='string'?[resolve(row).id,compact.needsReviewReason]:[resolve(row[0]).id,row[1]]));
if([...review.keys()].some(id=>candidateIds.has(id)))throw Error('Coverage overlap');
if(compact.rows&&candidateIds.size+review.size!==packet.mails.length)throw Error('Incomplete facts coverage');
const coverage=packet.mails.map((m:Mail)=>({mailId:m.id,outcome:candidateIds.has(m.id)?'candidate':review.has(m.id)?'needs_review':'no_change',reason:candidateIds.has(m.id)?'원문 근거를 포함한 전문 에이전트 후보':review.get(m.id)||compact.noChangeReason}));
writeFileSync(output,JSON.stringify({schemaVersion:1,runId:packet.runId,coverage,candidates},null,2),{flag:'wx'});
console.log(JSON.stringify({output,candidates:candidates.length,coverage:coverage.length}));
