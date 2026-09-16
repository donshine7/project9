import {readFileSync} from "node:fs";
import {createTemplateStore} from "./security/template-store.mjs";
import {inspectCapturedDocumentGroupBinding} from "./protocol/document-group-binding.mjs";

const read=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
let stage="configuration";
const result={mainTemplateReady:false,documentTemplateReady:false,valuesMatched:false,fingerprintsVerified:false,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false};
try{
  const candidates=read("../config/protocol-observations/local-read-fingerprints.json").candidates;
  const mainCandidate=candidates.find(item=>item.templateId==="matter-detail.main-record.v1");
  const documentCandidate=candidates.find(item=>item.templateId==="matter-detail.documents.v1");
  if(mainCandidate?.productionEnabled!==true||documentCandidate?.productionEnabled!==true)throw new Error();
  const store=createTemplateStore({candidates});
  stage="main-template";const mainEnvelope=await store.load(mainCandidate.templateId);result.mainTemplateReady=true;
  stage="document-template";const documentEnvelope=await store.load(documentCandidate.templateId);result.documentTemplateReady=true;
  stage="identity-compare";const evidence=inspectCapturedDocumentGroupBinding({mainEnvelope,documentEnvelope,mainCandidate,documentCandidate});
  result.valuesMatched=evidence.valuesMatched;result.fingerprintsVerified=evidence.fingerprintsVerified;
  console.log(JSON.stringify({status:"document-group-binding-ready",...result,sourceColumn:"idx",targetPredicateColumn:"GRP_KEY"}));
}catch{
  console.error(JSON.stringify({status:"document-group-binding-failed",failureStage:stage,...result}));process.exitCode=1;
}
