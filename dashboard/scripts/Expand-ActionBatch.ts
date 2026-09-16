import { readFileSync, writeFileSync } from 'node:fs';
const [packetPath, compactPath, output] = process.argv.slice(2);
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const packet = read(packetPath), compact = read(compactPath);
type Mail = Record<string,string>;
const resolve = (prefix: string): Mail => { const matches = packet.mails.filter((m: Mail) => m.id.startsWith(prefix)); if (matches.length !== 1) throw new Error(`Mail ${prefix}`); return matches[0]; };
type Field = [unknown, number, string, [string,string,string] | [string,string,string][]];
const candidates = compact.candidates.map((c: {ref: string; fields: Record<string,Field>}) => {
  const targets = Object.entries(packet.context.entities).filter(([key,value]) => key.startsWith('matter:') && (value as {our_ref:string}).our_ref === c.ref);
  if (targets.length !== 1) throw new Error(`Matter ${c.ref}`);
  return { key: `action-${c.ref}`, kind: 'action', entityType: 'matter', entityId: targets[0][0].slice(7), fields: Object.fromEntries(Object.entries(c.fields).map(([key,[value,confidence,rationale,quotes]]) => {
    const spans=(Array.isArray(quotes[0])?quotes:[quotes]) as [string,string,string][];
    const evidence=spans.map(([prefix,field,quote])=>{const mail=resolve(prefix);if(!quote||!mail[field]?.includes(quote))throw Error(`Nonliteral ${prefix}: ${quote}`);return {mailId:mail.id,field,quote};});
    return [key, {value,confidence,rationale,evidence}];
  })) };
});
const sourceCoverage=compact.coverage || [...compact.candidateMails.map((p:string)=>[p,'candidate','직접 요청 또는 담당 배정과 미완료 후속 근거가 있는 후보']),...compact.noChangeMails.map((p:string)=>[p,'no_change',compact.noChangeReason])];
const coverage = sourceCoverage.map(([prefix,outcome,reason]: string[]) => ({mailId:resolve(prefix).id,outcome,reason}));
if (coverage.length !== packet.mails.length || new Set(coverage.map((c:{mailId:string})=>c.mailId)).size !== packet.mails.length) throw new Error('Incomplete/duplicate coverage');
writeFileSync(output, JSON.stringify({schemaVersion:1,runId:packet.runId,coverage,candidates},null,2),{flag:'wx'});
console.log(JSON.stringify({output,count:candidates.length,coverage:coverage.length}));
