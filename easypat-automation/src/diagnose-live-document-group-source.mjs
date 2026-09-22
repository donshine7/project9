import {lstat,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createEasyPatRuntime} from "./runtime.mjs";
import {inspectDocumentGroupSourceBusinessEvidence} from "./protocol/document-group-source-business-evidence.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"live-document-group-source-attempt.v1.json");
let stage="preflight",claimed=false,startedAt,mainResult=null,progressResult=null;
try{
  const fingerprints=JSON.parse(await readFile(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8"));
  const sourceMetadata=JSON.parse(await readFile(path.join(root,"document-group-source-request.v1.json"),"utf8"));
  if(sourceMetadata?.sourceSessionId!==231||sourceMetadata.templateId!=="matter-detail.document-group-source.v1"||sourceMetadata.sourceClassification!=="unbound-source-candidate"||sourceMetadata.productionEnabled!==false)throw new Error();
  const [sourceEnvelope,documentEnvelope]=await Promise.all([
    createTemplateStore({candidates:[sourceMetadata]}).load(sourceMetadata.templateId),
    createTemplateStore({candidates:fingerprints.candidates}).load("matter-detail.documents.v1"),
  ]);
  if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"document-group-source-business-evidence",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  stage="read-fixed-business-records";const runtime=createEasyPatRuntime();
  mainResult=await runtime.read({templateId:"matter-detail.main-record.v1",matterReference:"P261793"});
  progressResult=await runtime.read({templateId:"matter-detail.progress-records.v1",matterReference:"P261793"});
  stage="compare-business-evidence";const result=inspectDocumentGroupSourceBusinessEvidence({sourceEnvelope,documentEnvelope,mainResult,progressResult});
  const completedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"document-group-source-business-evidence",matterReference:"P261793",startedAt,completedAt,businessReadRequestCount:2,matchCount:result.matchCount,documentGroupMatchCount:result.documentGroupMatchCount}),{mode:0o600});
  console.log(JSON.stringify({...result,businessReadRequestCount:2}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"document-group-source-business-evidence",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-document-group-source-diagnostic-failed",failureStage:stage,rawValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));process.exitCode=1;
}finally{mainResult=null;progressResult=null;}
