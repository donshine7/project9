import { readFileSync } from "node:fs";
import { fingerprintEnvelope } from "./protocol/template-fingerprint.mjs";
import { createReadOnlyBatch } from "./protocol/read-only-guard.mjs";
import { collectLiteralEqualities } from "./protocol/matter-linkage.mjs";
import { compilePredicateResponseIdentity } from "./protocol/response-identity.mjs";
import { createTemplateStore } from "./security/template-store.mjs";

const chunks=[];let size=0,mainEnvelope=null,progressSql=null,stage="read-input";
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  progressSql=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  stage="load-config";
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8"));
  const registry=readJson("../config/read-template-registry.json"),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json");
  const progress=fingerprints.candidates.find(item=>item.templateId==="matter-detail.progress-records.v1"),mainCandidate=fingerprints.candidates.find(item=>item.templateId==="matter-detail.main-record.v1"),mainConfig=registry.templates.find(item=>item.templateId==="matter-detail.main-record.v1");
  if(progress?.sessionId!==174||progress.command!=="SELECT"||progress.statementCount!==1||!progress.fingerprint||mainConfig?.enabled!==true||mainConfig.boundMatterReference!=="P261793")throw new Error();
  stage="verify-progress-template";
  const progressEnvelope={templateId:progress.templateId,command:"SELECT",statements:[progressSql]};createReadOnlyBatch([progressEnvelope]);
  if(fingerprintEnvelope(progressEnvelope)!==progress.fingerprint)throw new Error();
  stage="load-main-template";
  const store=createTemplateStore({candidates:fingerprints.candidates});mainEnvelope=await store.load(mainCandidate.templateId);
  stage="compile-main-identity";
  const mainBinding=compilePredicateResponseIdentity(mainEnvelope.statements[0],mainConfig.responseVerification);
  stage="compare-linkage";
  const matches=collectLiteralEqualities(progressSql).filter(item=>item.literal===mainBinding.expectedValue);
  const columns=[...new Set(matches.map(item=>item.column))];
  if(matches.length<1||columns.length<1)throw new Error();
  console.log(JSON.stringify({status:"progress-template-linked-to-p261793",sessionId:174,templateId:progress.templateId,matterReference:"P261793",matchingPredicateCount:matches.length,matchingPredicateColumns:columns,mainIdentityColumn:mainBinding.responseColumn,candidateFingerprint:progress.fingerprint,captureFingerprintMatched:true,productionEnabled:false,executable:false,rawStatementsReturned:false,internalIdentityReturned:false,serverRequestSent:false}));
}catch{console.error(JSON.stringify({status:"rejected",reason:"progress linkage evidence is incomplete or mismatched",failureStage:stage,productionEnabled:false,rawValuesReturned:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));mainEnvelope=null;progressSql=null;}
