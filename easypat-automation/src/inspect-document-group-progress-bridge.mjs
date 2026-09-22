import {readFileSync} from "node:fs";
import {lstat,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeCopiedResultsetInput,diagnoseCopiedResultsetInput} from "./protocol/copied-resultset-input.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";
import {inspectDocumentGroupProgressBridge} from "./protocol/document-group-progress-bridge.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const chunks=[];let size=0,stage="read-input",progressDiagnostic,intermediateDiagnostic,comparisonDiagnostic;
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),evidencePath=path.join(root,"document-group-progress-bridge.v1.json");
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>4*1024*1024)throw new Error();chunks.push(chunk);}
  const input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
  if(!input||Object.keys(input).sort().join(",")!=="intermediateResponse,progressResponse"||typeof input.progressResponse!=="string"||typeof input.intermediateResponse!=="string")throw new Error();
  stage="parse-progress-response";progressDiagnostic=diagnoseCopiedResultsetInput(input.progressResponse);const progressResult=normalizeCopiedResultsetInput(input.progressResponse).result;
  stage="parse-intermediate-response";intermediateDiagnostic=diagnoseCopiedResultsetInput(input.intermediateResponse);const intermediateResult=normalizeCopiedResultsetInput(input.intermediateResponse).result;
  stage="load-configuration";
  const candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates;
  const registry=JSON.parse(readFileSync(new URL("../config/generic-read-template-registry.json",import.meta.url),"utf8"));
  const progressDefinition=registry.templates.find(item=>item.templateId==="matter-detail.progress-records.v1");
  const requestMetadata=JSON.parse(await readFile(path.join(root,capture.requestMetadataFile),"utf8"));
  if(requestMetadata?.schemaVersion!==capture.schemaVersion||requestMetadata.templateId!==capture.templateId||requestMetadata.sourceSessionId!==capture.sourceSessionId||requestMetadata.productionEnabled!==false||
     !Array.isArray(progressDefinition?.expectedResponseColumns)||progressDefinition.expectedResponseColumns.length!==55)throw new Error();
  stage="load-encrypted-templates";
  const knownStore=createTemplateStore({candidates});
  const [mainEnvelope,progressEnvelope,documentEnvelope,intermediateEnvelope]=await Promise.all([
    knownStore.load("matter-detail.main-record.v1"),knownStore.load("matter-detail.progress-records.v1"),knownStore.load("matter-detail.documents.v1"),
    createTemplateStore({candidates:[requestMetadata]}).load(capture.templateId),
  ]);
  stage="compare-bridge";
  const result=inspectDocumentGroupProgressBridge({mainEnvelope,progressEnvelope,progressResult,intermediateEnvelope,intermediateResult,documentEnvelope,expectedColumns:progressDefinition.expectedResponseColumns});
  const evidence={schemaVersion:1,status:result.status,sourceSessions:[174,245,247],progressResponseRowCount:result.progressResponseRowCount,intermediateResponseRowCount:result.intermediateResponseRowCount,intermediateRequestPredicateColumn:result.intermediateRequestPredicateColumn,progressMatchColumn:result.progressMatchColumn,progressParentColumn:result.progressParentColumn,documentGroupResponseColumn:result.documentGroupResponseColumn,documentTargetPredicateColumn:result.documentTargetPredicateColumn,matchedProgressRowCount:result.matchedProgressRowCount,progressMatterBindingVerified:result.progressMatterBindingVerified,intermediateRequestResponseVerified:result.intermediateRequestResponseVerified,documentGroupBindingVerified:result.documentGroupBindingVerified,rawRowsStored:false,productionEnabled:false};
  if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  stage="save-evidence";
  try{await writeFile(evidencePath,JSON.stringify(evidence),{flag:"wx",mode:0o600});}catch(error){if(error?.code!=="EEXIST")throw error;const existing=JSON.parse(await readFile(evidencePath,"utf8"));if(JSON.stringify(existing)!==JSON.stringify(evidence))throw new Error();}
  console.log(JSON.stringify({...result,rawRowsStored:false}));
}catch(error){
  if(stage==="compare-bridge"&&error?.safeDiagnostic)comparisonDiagnostic=error.safeDiagnostic;
  console.error(JSON.stringify({status:"document-group-progress-bridge-rejected",failureStage:stage,progressDiagnostic,intermediateDiagnostic,comparisonDiagnostic,rawValuesReturned:false,rawRowsStored:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;
}finally{chunks.forEach(chunk=>chunk.fill(0));}
