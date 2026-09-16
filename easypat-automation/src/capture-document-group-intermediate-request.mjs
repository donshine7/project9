import {readFileSync} from "node:fs";
import {lstat,mkdir,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {inspectDocumentGroupIntermediateRequest} from "./protocol/document-group-intermediate.mjs";
import {diagnoseCopiedSqlInput,normalizeCopiedSqlInput} from "./protocol/copied-sql-input.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const chunks=[];let size=0,statement=null,inputDiagnostic=null,stage="read-input";
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),metadataPath=path.join(root,"document-group-intermediate-request.v1.json");
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  const copied=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));inputDiagnostic=diagnoseCopiedSqlInput(copied);stage="normalize-input";const normalized=normalizeCopiedSqlInput(copied);statement=normalized.sql;
  const candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates,knownStore=createTemplateStore({candidates});
  stage="load-baseline-templates";const [mainEnvelope,documentEnvelope]=await Promise.all([knownStore.load("matter-detail.main-record.v1"),knownStore.load("matter-detail.documents.v1")]);
  stage="inspect-request";const evidence=inspectDocumentGroupIntermediateRequest({statement,mainEnvelope,documentEnvelope});
  const candidate={sessionId:245,templateId:evidence.envelope.templateId,command:"SELECT",statementCount:1,fingerprint:evidence.fingerprint,productionEnabled:false};
  stage="store-encrypted-template";const store=createTemplateStore({candidates:[candidate]});let alreadyStored=false;
  try{await store.load(candidate.templateId);alreadyStored=true;}catch{await store.save(candidate.templateId,evidence.envelope);}
  await store.load(candidate.templateId);
  await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  const sourceClassification=evidence.matterIdentityBindingObserved?"matter-bound-intermediate-candidate":"unbound-intermediate-capture";
  const metadata={schemaVersion:1,status:"captured",sourceSessionId:245,templateId:candidate.templateId,command:"SELECT",statementCount:1,fingerprint:candidate.fingerprint,sourceClassification,matterIdentityPredicateColumns:evidence.matterIdentityPredicateColumns,documentGroupPredicateColumns:evidence.documentGroupPredicateColumns,matterIdentityBindingObserved:evidence.matterIdentityBindingObserved,documentGroupPredicateObserved:evidence.documentGroupPredicateObserved,predicateInspectionSupported:evidence.predicateInspectionSupported,predicateCount:evidence.predicateCount,plaintextStored:false,productionEnabled:false};
  try{await writeFile(metadataPath,JSON.stringify(metadata),{flag:"wx",mode:0o600});}catch(error){if(error?.code!=="EEXIST")throw error;const existing=JSON.parse(await readFile(metadataPath,"utf8"));if(JSON.stringify(existing)!==JSON.stringify(metadata))throw new Error();}
  console.log(JSON.stringify({status:"document-group-intermediate-request-captured",sourceSessionId:245,inputFormat:normalized.inputFormat,templateId:candidate.templateId,fingerprint:candidate.fingerprint,sourceClassification,matterIdentityPredicateColumns:evidence.matterIdentityPredicateColumns,documentGroupPredicateColumns:evidence.documentGroupPredicateColumns,matterIdentityBindingObserved:evidence.matterIdentityBindingObserved,documentGroupPredicateObserved:evidence.documentGroupPredicateObserved,predicateInspectionSupported:evidence.predicateInspectionSupported,predicateCount:evidence.predicateCount,encryptedTemplateStored:true,alreadyStored,plaintextStored:false,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));
}catch(error){const failureCode=stage==="read-input"?"INPUT_UNREADABLE":stage==="normalize-input"?"CLIPBOARD_NOT_SQL_FIELD_VALUE":stage==="load-baseline-templates"?"BASELINE_TEMPLATE_UNAVAILABLE":stage==="inspect-request"?"NOT_READ_ONLY_OR_UNSUPPORTED_SQL":stage==="store-encrypted-template"?"ENCRYPTED_STORE_FAILED":"LOCAL_METADATA_FAILED";console.error(JSON.stringify({status:"document-group-intermediate-request-rejected",failureStage:stage,failureCode,inputDiagnostic:inputDiagnostic??undefined,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));statement=null;}
