import {readFile} from "node:fs/promises";
import {collectLiteralEqualities} from "./protocol/matter-linkage.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

let stage="load-metadata";
try{
  const metadata=JSON.parse(await readFile(new URL(`../.local/templates-user/${capture.requestMetadataFile}`,import.meta.url),"utf8"));
  if(metadata?.schemaVersion!==capture.schemaVersion||metadata.templateId!==capture.templateId||
     metadata.command!=="SELECT"||metadata.statementCount!==1||metadata.productionEnabled!==false)throw new Error();
  stage="load-template";
  const envelope=await createTemplateStore({candidates:[metadata]}).load(metadata.templateId);
  stage="inspect-predicates";
  const predicates=collectLiteralEqualities(envelope.statements[0]);
  const counts=new Map();
  for(const predicate of predicates)counts.set(predicate.column,(counts.get(predicate.column)??0)+1);
  console.log(JSON.stringify({
    status:"document-group-intermediate-binding-diagnosed",
    templateId:metadata.templateId,
    predicateCount:predicates.length,
    predicateColumns:[...counts].map(([column,occurrenceCount])=>({column,occurrenceCount})),
    rawStatementReturned:false,
    literalValuesReturned:false,
    serverRequestsPerformed:0,
    productionEnabled:false,
  }));
}catch{
  console.error(JSON.stringify({status:"document-group-intermediate-binding-diagnostic-failed",failureStage:stage,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));
  process.exitCode=1;
}
