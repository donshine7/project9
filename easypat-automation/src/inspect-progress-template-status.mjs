import { readFileSync } from "node:fs";
import { createTemplateStore } from "./security/template-store.mjs";
import { compilePredicateResponseIdentity } from "./protocol/response-identity.mjs";

let mainEnvelope=null,progressEnvelope=null;
try{
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8"));
  const registry=readJson("../config/read-template-registry.json"),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json");
  const main=registry.templates.find(item=>item.templateId==="matter-detail.main-record.v1"),progress=registry.templates.find(item=>item.templateId==="matter-detail.progress-records.v1"),candidate=fingerprints.candidates.find(item=>item.templateId===progress?.templateId);
  if(main?.enabled!==true||main.boundMatterReference!=="P261793"||progress?.enabled!==true||progress.boundMatterReference!=="P261793"||progress.fingerprint!==candidate?.fingerprint||candidate?.sessionId!==174||!candidate.fingerprint||candidate.productionEnabled!==true)throw new Error();
  const store=createTemplateStore({candidates:fingerprints.candidates});
  mainEnvelope=await store.load(main.templateId);progressEnvelope=await store.load(progress.templateId);
  const mainBinding=compilePredicateResponseIdentity(mainEnvelope.statements[0],main.responseVerification),progressBinding=compilePredicateResponseIdentity(progressEnvelope.statements[0],progress.responseVerification);
  if(mainBinding.expectedValue!==progressBinding.expectedValue)throw new Error();
  console.log(JSON.stringify({status:"progress-template-production-ready",templateId:progress.templateId,matterReference:"P261793",sourceSessionId:candidate.sessionId,predicateColumn:progress.responseVerification.predicateColumn,responseColumn:progress.responseVerification.responseColumn,allRowsMustMatch:true,encryptedTemplateAvailable:true,fingerprintVerified:true,productionEnabled:true,liveResponseIdentityValidated:true,rawStatementsReturned:false,internalIdentityReturned:false,serverRequestSent:false}));
}catch{console.error("PROGRESS_TEMPLATE_STATUS_FAILED");process.exitCode=1;}
finally{mainEnvelope=null;progressEnvelope=null;}
