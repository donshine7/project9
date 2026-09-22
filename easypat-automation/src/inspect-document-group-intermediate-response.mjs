import {readFileSync} from "node:fs";
import {lstat,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeCopiedResultsetInput,diagnoseCopiedResultsetInput} from "./protocol/copied-resultset-input.mjs";
import {diagnoseDocumentRequest} from "./protocol/document-request-diagnostic.mjs";
import {inspectDocumentGroupIntermediateResponse} from "./protocol/document-group-intermediate-response.mjs";
import {createTemplateStore} from "./security/template-store.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";

const chunks=[];let size=0,stage="read-response",inputDiagnostic,requestDiagnostic;
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),requestMetadataPath=path.join(root,capture.requestMetadataFile),evidencePath=path.join(root,capture.responseEvidenceFile);
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>2*1024*1024)throw new Error();chunks.push(chunk);}
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  stage="parse-response";inputDiagnostic=diagnoseCopiedResultsetInput(raw);const normalized=normalizeCopiedResultsetInput(raw);
  stage="load-request-metadata";const requestMetadata=JSON.parse(await readFile(requestMetadataPath,"utf8"));
  if(requestMetadata?.schemaVersion!==capture.schemaVersion||requestMetadata.sourceSessionId!==capture.sourceSessionId||requestMetadata.templateId!==capture.templateId||!/^[a-f0-9]{64}$/.test(requestMetadata.fingerprint??"")||requestMetadata.productionEnabled!==false)throw new Error();
  const candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates,knownStore=createTemplateStore({candidates});
  stage="load-intermediate-template";const intermediateEnvelope=await createTemplateStore({candidates:[requestMetadata]}).load(requestMetadata.templateId);
  stage="validate-request-evidence";requestDiagnostic=diagnoseDocumentRequest(intermediateEnvelope.statements[0]);
  if(requestDiagnostic.shellSyntaxDetected||!requestDiagnostic.fromClauseObserved||!requestDiagnostic.predicateInspectionSupported)throw new Error();
  stage="load-baseline-templates";const [mainEnvelope,documentEnvelope]=await Promise.all([knownStore.load("matter-detail.main-record.v1"),knownStore.load("matter-detail.documents.v1")]);
  stage="compare-response";
  const result=inspectDocumentGroupIntermediateResponse({result:normalized.result,mainEnvelope,documentEnvelope});
  if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  stage="save-evidence";const evidence={schemaVersion:2,status:result.status,sourceSessionId:245,templateId:requestMetadata.templateId,requestFingerprint:requestMetadata.fingerprint,responseColumns:result.responseColumns,responseColumnCount:result.responseColumnCount,responseRowCount:result.responseRowCount,matterIdentityCandidateColumns:result.matterIdentityCandidateColumns,documentGroupCandidateColumns:result.documentGroupCandidateColumns,jointRowCount:result.jointRowCount,rawRowsStored:false,productionEnabled:false};
  try{await writeFile(evidencePath,JSON.stringify(evidence),{flag:"wx",mode:0o600});}catch(error){if(error?.code!=="EEXIST")throw error;const existing=JSON.parse(await readFile(evidencePath,"utf8"));if(JSON.stringify(existing)!==JSON.stringify(evidence))throw new Error();}
  console.log(JSON.stringify({status:result.status,sourceSessionId:245,inputFormat:normalized.inputFormat,pipelineNewlineRemoved:normalized.pipelineNewlineRemoved,responseColumnCount:result.responseColumnCount,responseRowCount:result.responseRowCount,matterIdentityCandidateColumns:result.matterIdentityCandidateColumns,documentGroupCandidateColumns:result.documentGroupCandidateColumns,jointRowCount:result.jointRowCount,intermediateTemplateCrossProcessReusable:true,rawRowsReturned:false,rawRowsStored:false,internalValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));
}catch{console.error(JSON.stringify({status:"document-group-intermediate-response-rejected",failureStage:stage,inputDiagnostic,requestDiagnostic,rawValuesReturned:false,rawRowsStored:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));}
