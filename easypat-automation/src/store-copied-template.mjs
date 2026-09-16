import { readFileSync } from "node:fs";
import { createTemplateStore } from "./security/template-store.mjs";
import { fingerprintEnvelope } from "./protocol/template-fingerprint.mjs";
const chunks=[];let size=0;
try{
  const candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url))).candidates;
  const c=candidates.find(c=>String(c.sessionId)===process.argv[2]&&c.command==="SELECT");
  if(!c)throw new Error();
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  const sql=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  const envelope={templateId:c.templateId,command:"SELECT",statements:[sql]};
  if(fingerprintEnvelope(envelope)!==c.fingerprint)throw new Error();
  const store=createTemplateStore({candidates});
  let exists=false;
  try{await store.load(c.templateId);exists=true;}catch{ /* Exclusive save below rejects a corrupt existing file. */ }
  if(!exists)await store.save(c.templateId,envelope);
  const loaded=await store.load(c.templateId);
  if(fingerprintEnvelope(loaded)!==c.fingerprint)throw new Error();
  console.log(JSON.stringify({sessionId:c.sessionId,templateId:c.templateId,candidateFingerprint:c.fingerprint,stored:true,alreadyStored:exists,roundTripVerified:true,protection:"Windows-DPAPI-CurrentUser",plaintextWritten:false,executable:false}));
}catch{console.error('{"status":"rejected","reason":"template import failed","executable":false}');process.exitCode=1;}
finally{chunks.forEach(c=>c.fill(0));}
