import {readFileSync} from "node:fs";
import {lstat,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeCopiedResultsetInput,diagnoseCopiedResultsetInput} from "./protocol/copied-resultset-input.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";
import {inspectDocumentGroupSourceResponse} from "./protocol/document-group-source-response.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const chunks=[];let size=0,stage="read-response",inputDiagnostic;
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),evidencePath=path.join(root,"document-group-source-response-231.v1.json");
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>2*1024*1024)throw new Error();chunks.push(chunk);}
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  stage="parse-response";inputDiagnostic=diagnoseCopiedResultsetInput(raw);const result=normalizeCopiedResultsetInput(raw).result;
  stage="load-configuration";
  const candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates;
  const registry=JSON.parse(readFileSync(new URL("../config/generic-read-template-registry.json",import.meta.url),"utf8"));
  const expectedColumns=registry.templates.find(item=>item.templateId==="matter-detail.progress-records.v1")?.expectedResponseColumns;
  const requestMetadata=JSON.parse(await readFile(path.join(root,capture.requestMetadataFile),"utf8"));
  if(requestMetadata?.schemaVersion!==capture.schemaVersion||requestMetadata.templateId!==capture.templateId||requestMetadata.sourceSessionId!==capture.sourceSessionId)throw new Error();
  stage="load-encrypted-templates";
  const [documentEnvelope,intermediateEnvelope]=await Promise.all([
    createTemplateStore({candidates}).load("matter-detail.documents.v1"),
    createTemplateStore({candidates:[requestMetadata]}).load(capture.templateId),
  ]);
  stage="compare-source";const inspected=inspectDocumentGroupSourceResponse({result,intermediateEnvelope,documentEnvelope,expectedColumns});
  const evidence={schemaVersion:1,...inspected,rawRowsReturned:undefined,internalValuesReturned:undefined,rawRowsStored:false};
  if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  stage="save-evidence";
  try{await writeFile(evidencePath,JSON.stringify(evidence),{flag:"wx",mode:0o600});}catch(error){if(error?.code!=="EEXIST")throw error;const existing=JSON.parse(await readFile(evidencePath,"utf8"));if(JSON.stringify(existing)!==JSON.stringify(evidence))throw new Error();}
  console.log(JSON.stringify({...inspected,rawRowsStored:false}));
}catch{console.error(JSON.stringify({status:"document-group-source-response-rejected",failureStage:stage,inputDiagnostic,rawValuesReturned:false,rawRowsStored:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));}
