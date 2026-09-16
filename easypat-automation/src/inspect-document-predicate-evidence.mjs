import { readFileSync } from "node:fs";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyPatRuntime } from "./runtime.mjs";
import { inspectDocumentPredicateEvidence } from "./protocol/document-linkage.mjs";

const chunks=[];let size=0,statement=null,progressResult=null,claimed=false,startedAt,stage="read-input";
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"document-linkage-evidence-p261793-attempt.v2.json");
try{
  if(process.argv[2]!=="247")throw new Error();
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  statement=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8")),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json"),candidate=fingerprints.candidates.find(item=>item.sessionId===247);
  stage="preflight";
  inspectDocumentPredicateEvidence({statement,candidate,progressResult:{matterReference:"P261793",templateId:"matter-detail.progress-records.v1",columns:["idx","idx_parent","serial","sourcecode","no_rec","sort"],rows:[{idx:"preflight-idx",idx_parent:"preflight-parent",serial:"preflight-serial",sourcecode:"preflight-source",no_rec:"preflight-number",sort:"preflight-sort"}]}});
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"document-predicate-evidence",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  stage="read-progress";const runtime=createEasyPatRuntime();progressResult=await runtime.read({templateId:"matter-detail.progress-records.v1",matterReference:"P261793"});
  stage="compare-evidence";const result=inspectDocumentPredicateEvidence({statement,candidate,progressResult});
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"document-predicate-evidence",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),matchCount:result.matches.length}),{mode:0o600});
  console.log(JSON.stringify({...result,candidateFingerprint:candidate.fingerprint,productionEnabled:false,serverMutationPerformed:false,automaticRetryPerformed:false}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"document-predicate-evidence",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}console.error(JSON.stringify({status:"rejected",failureStage:stage,productionEnabled:false,rawValuesReturned:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));statement=null;progressResult=null;}
