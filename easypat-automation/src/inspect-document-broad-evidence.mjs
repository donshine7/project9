import { readFileSync } from "node:fs";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyPatRuntime } from "./runtime.mjs";
import { inspectDocumentBroadPredicateEvidence } from "./protocol/document-linkage.mjs";
import { createTemplateStore } from "./security/template-store.mjs";

const chunks=[];let size=0,statement=null,mainResult=null,progressResult=null,claimed=false,startedAt,stage="read-input";
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"document-broad-evidence-p261793-attempt.v1.json");
try{
  if(process.argv[2]!=="247")throw new Error();
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  statement=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8")),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json"),candidate=fingerprints.candidates.find(item=>item.sessionId===247),envelope={templateId:candidate.templateId,command:"SELECT",statements:[statement]};
  stage="preflight";inspectDocumentBroadPredicateEvidence({statement,candidate,mainResult:{matterReference:"P261793",templateId:"matter-detail.main-record.v1",columns:["probe"],rows:[{probe:"main-probe"}]},progressResult:{matterReference:"P261793",templateId:"matter-detail.progress-records.v1",columns:["probe"],rows:[{probe:"progress-probe"}]}});
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  stage="store-template";const store=createTemplateStore({candidates:fingerprints.candidates});let alreadyStored=false;try{await store.load(candidate.templateId);alreadyStored=true;}catch{}
  if(!alreadyStored)await store.save(candidate.templateId,envelope);await store.load(candidate.templateId);
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"document-broad-evidence",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  stage="read-business-records";const runtime=createEasyPatRuntime();mainResult=await runtime.read({templateId:"matter-detail.main-record.v1",matterReference:"P261793"});progressResult=await runtime.read({templateId:"matter-detail.progress-records.v1",matterReference:"P261793"});
  stage="compare-evidence";const result=inspectDocumentBroadPredicateEvidence({statement,candidate,mainResult,progressResult});
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"document-broad-evidence",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),matchCount:result.matches.length}),{mode:0o600});
  console.log(JSON.stringify({...result,candidateFingerprint:candidate.fingerprint,encryptedTemplateStored:true,encryptedTemplateRoundTripVerified:true,alreadyStored,productionEnabled:false,serverMutationPerformed:false,automaticRetryPerformed:false}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"document-broad-evidence",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}console.error(JSON.stringify({status:"rejected",failureStage:stage,productionEnabled:false,rawValuesReturned:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));statement=null;mainResult=null;progressResult=null;}
