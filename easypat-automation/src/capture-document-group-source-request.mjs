import {lstat,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeCopiedSqlInput,diagnoseCopiedSqlInput} from "./protocol/copied-sql-input.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";
import {inspectDocumentGroupSourceRequest} from "./protocol/document-group-source-request.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const chunks=[];let size=0,stage="read-input",inputDiagnostic;
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),metadataPath=path.join(root,"document-group-source-request.v1.json");
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  stage="normalize-input";inputDiagnostic=diagnoseCopiedSqlInput(raw);const statement=normalizeCopiedSqlInput(raw).sql;
  stage="load-templates";
  const fingerprints=JSON.parse(await readFile(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8"));
  const intermediateMetadata=JSON.parse(await readFile(path.join(root,capture.requestMetadataFile),"utf8"));
  const knownStore=createTemplateStore({candidates:fingerprints.candidates});
  const [mainEnvelope,progressEnvelope,documentEnvelope,intermediateEnvelope]=await Promise.all([
    knownStore.load("matter-detail.main-record.v1"),knownStore.load("matter-detail.progress-records.v1"),knownStore.load("matter-detail.documents.v1"),
    createTemplateStore({candidates:[intermediateMetadata]}).load(capture.templateId),
  ]);
  stage="inspect-request";const inspected=inspectDocumentGroupSourceRequest({statement,mainEnvelope,progressEnvelope,intermediateEnvelope,documentEnvelope});
  const candidate={sessionId:231,templateId:inspected.envelope.templateId,command:"SELECT",statementCount:1,fingerprint:inspected.fingerprint,productionEnabled:false};
  stage="store-encrypted-template";const store=createTemplateStore({candidates:[candidate]});let alreadyStored=false;
  try{await store.load(candidate.templateId);alreadyStored=true;}catch{await store.save(candidate.templateId,inspected.envelope);}
  await store.load(candidate.templateId);
  const metadata={schemaVersion:1,status:"captured",sourceSessionId:231,templateId:candidate.templateId,command:"SELECT",statementCount:1,fingerprint:candidate.fingerprint,sourceClassification:inspected.sourceClassification,predicateCount:inspected.predicateCount,matterIdentityPredicateColumns:inspected.matterIdentityPredicateColumns,intermediateIdentityPredicateColumns:inspected.intermediateIdentityPredicateColumns,documentGroupPredicateColumns:inspected.documentGroupPredicateColumns,sameAsIntermediateStatement:inspected.sameAsIntermediateStatement,plaintextStored:false,productionEnabled:false};
  if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  stage="save-metadata";
  try{await writeFile(metadataPath,JSON.stringify(metadata),{flag:"wx",mode:0o600});}catch(error){if(error?.code!=="EEXIST")throw error;const existing=JSON.parse(await readFile(metadataPath,"utf8"));if(JSON.stringify(existing)!==JSON.stringify(metadata))throw new Error();}
  console.log(JSON.stringify({status:"document-group-source-request-captured",sourceSessionId:231,inputFormat:normalizeCopiedSqlInput(raw).inputFormat,templateId:candidate.templateId,fingerprint:candidate.fingerprint,sourceClassification:inspected.sourceClassification,predicateCount:inspected.predicateCount,matterIdentityPredicateColumns:inspected.matterIdentityPredicateColumns,intermediateIdentityPredicateColumns:inspected.intermediateIdentityPredicateColumns,documentGroupPredicateColumns:inspected.documentGroupPredicateColumns,sameAsIntermediateStatement:inspected.sameAsIntermediateStatement,encryptedTemplateStored:true,alreadyStored,plaintextStored:false,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));
}catch{console.error(JSON.stringify({status:"document-group-source-request-rejected",failureStage:stage,inputDiagnostic,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));}
