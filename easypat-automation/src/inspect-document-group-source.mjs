import {readFileSync} from "node:fs";
import {inspectCapturedDocumentGroupSources} from "./protocol/document-group-source.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const read=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
let stage="configuration";
try{
  const candidates=read("../config/protocol-observations/local-read-fingerprints.json").candidates,store=createTemplateStore({candidates});
  const candidate=id=>candidates.find(item=>item.templateId===id),documentCandidate=candidate("matter-detail.documents.v1");
  const sourceIds=["matter-detail.main-record.v1","matter-detail.progress-records.v1","matter-detail.related-counts.v1"];
  if(!documentCandidate||sourceIds.some(id=>!candidate(id)))throw new Error();
  stage="load-encrypted-templates";
  const documentEnvelope=await store.load(documentCandidate.templateId),sourceEnvelopes=await Promise.all(sourceIds.map(id=>store.load(id)));
  stage="compare-captured-predicates";
  const result=inspectCapturedDocumentGroupSources({documentEnvelope,documentCandidate,sources:sourceIds.map((id,index)=>({envelope:sourceEnvelopes[index],candidate:candidate(id)}))});
  console.log(JSON.stringify({status:result.status,matchCount:result.matchCount,matches:result.matches,fingerprintsVerified:true,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false,nextEvidenceSessionId:245}));
}catch{console.error(JSON.stringify({status:"document-group-source-diagnostic-failed",failureStage:stage,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;}
