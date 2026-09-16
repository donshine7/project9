import { readFileSync, writeFileSync } from 'node:fs';
import { hasExactMatterReference, matterReferenceTokens } from '../lib/matter-number';
const [packetPath,compactPath,output] = process.argv.slice(2);
const read=(p:string)=>JSON.parse(readFileSync(p,'utf8'));
const packet=read(packetPath), compact=read(compactPath);
type Mail=Record<string,string>;
const resolve=(prefix:string):Mail=>{const matches=packet.mails.filter((m:Mail)=>m.id.startsWith(prefix));if(matches.length!==1)throw new Error(`Mail ${prefix}`);return matches[0];};
type Fact=[string,string,string,number,string,Array<[string,string]>];
const candidates=(compact.facts as Fact[]).map(([prefix,ref,value,confidence,rationale,quotes])=>{
  const mail=resolve(prefix),scope=packet.taskScope.find((s:{mailId:string})=>s.mailId===mail.id);
  if(!scope.targetMatterRefs.includes(ref)||!hasExactMatterReference(value,ref)||new Set(matterReferenceTokens(value)).size!==1)throw new Error(`Target scope ${prefix} ${ref}`);
  const evidence=quotes.map(([field,quote])=>{if(!mail[field]?.includes(quote))throw new Error(`Nonliteral ${prefix} ${quote}`);return {mailId:mail.id,field,quote};});
  return {key:`scope-${prefix}-${ref}`,kind:'fact',entityType:'mail',entityId:mail.id,fields:{summary:{value,confidence,rationale,evidence}}};
});
const coverage=compact.coverage.map(([prefix,outcome,reason]:string[])=>({mailId:resolve(prefix).id,outcome,reason}));
if(coverage.length!==packet.mails.length||new Set(coverage.map((c:{mailId:string})=>c.mailId)).size!==packet.mails.length)throw new Error('Coverage');
writeFileSync(output,JSON.stringify({schemaVersion:1,runId:packet.runId,coverage,candidates},null,2),{flag:'wx'});
console.log(JSON.stringify({output,count:candidates.length,coverage:coverage.length}));
