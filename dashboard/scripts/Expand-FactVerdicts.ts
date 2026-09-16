import { readFileSync, writeFileSync } from 'node:fs';
// Mechanical transport adapter: copy the verifier's verdict, confidence, rationale and
// evidence; resolve unambiguous candidate prefixes against its frozen input only.
const [packetPath, compactPath, resultPath, sourceRunId] = process.argv.slice(2);
if (!resultPath) throw new Error('Usage: Expand-FactVerdicts <focused-packet> <compact-verdicts> <new-result>');
const packet = JSON.parse(readFileSync(packetPath,'utf8'));
const targets = packet.targetCandidates || packet.context.candidates.filter((c:{run_id:string;kind:string}) => c.run_id === sourceRunId && c.kind === 'fact');
type Verdict = [string,string,number,string,Array<[string,string] | [string,string,string] | [string,string,number,number]>];
const verdicts = JSON.parse(readFileSync(compactPath,'utf8')) as Verdict[];
if (verdicts.length !== targets.length) throw new Error('Incomplete verifier coverage');
const seen = new Set();
const candidates = verdicts.map(([prefix,verdict,confidence,rationale,quotes]) => {
  const matches = targets.filter((c:{id:string}) => c.id.startsWith(prefix));
  if (matches.length !== 1 || seen.has(matches[0].id)) throw new Error(`Ambiguous or duplicate candidate: ${prefix}`);
  const c = matches[0]; seen.add(c.id);
  const sourceEntityId = JSON.parse(c.payload_json).entityId;
  const evidence = quotes.map(parts => {
    const prefix=parts.length===2?sourceEntityId:parts[0];
    const field=parts.length===2?parts[0]:parts[1];
    const matches = packet.mails.filter((m:{id:string}) => m.id.startsWith(prefix));
    if (matches.length !== 1) throw new Error(`Ambiguous evidence mail ${prefix}`);
    const mail = matches[0], mailId = mail.id;
    if(parts.length===4 && (!Number.isInteger(parts[2])||!Number.isInteger(parts[3])||parts[2]<0||parts[3]<=parts[2]||typeof mail[field]!=='string'||parts[3]>mail[field].length))throw Error('Invalid verifier span');
    const quote=parts.length===4?mail[field].slice(parts[2],parts[3]):parts.length===3?parts[2]:parts[1];
    if (typeof mail[field] !== 'string' || !mail[field].includes(quote)) throw new Error(`Nonliteral evidence ${prefix}: ${quote}`);
    return {mailId,field,quote};
  });
  return {key:`verify-${prefix}`,kind:'risk',entityType:'candidate',entityId:c.id,fields:{verdict:{value:verdict,confidence,rationale,evidence}}};
});
const coverage = packet.mails.map((m:{id:string}) => {
  const c = candidates.find(c => c.fields.verdict.evidence.some(e => e.mailId === m.id));
  if (!c) throw new Error(`Missing mail coverage ${m.id}`);
  return {mailId:m.id,outcome:'candidate',reason:c.fields.verdict.rationale};
});
writeFileSync(resultPath,JSON.stringify({schemaVersion:1,runId:packet.runId,coverage,candidates},null,2),{flag:'wx'});
console.log(JSON.stringify({runId:packet.runId,candidates:candidates.length,resultPath}));
