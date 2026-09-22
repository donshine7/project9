import {lstat,mkdir,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {inspectDomesticReportUploadCapture} from "./protocol/domestic-report-upload-capture.mjs";
import {createMutationTemplateStore} from "./security/mutation-template-store.mjs";

const allowedKinds=new Set(["file-transfer","progress-insert-batch","attach-insert","history-batch","progress-readback","attachment-readback"]),kind=process.argv[2],chunks=[];let total=0,raw=null,stage="read-input";
try{
  if(!allowedKinds.has(kind))throw new Error();
  for await(const chunk of process.stdin){total+=chunk.length;if(total>2*1024*1024)throw new Error();chunks.push(chunk);}
  raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));stage="inspect-request";
  const capture=inspectDomesticReportUploadCapture({kind,raw}),root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
  await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  let encryptedTemplateStored=false,alreadyStored=false;
  if(capture.envelope){
    stage="store-encrypted-template";const candidate={templateId:capture.definition.templateId,command:capture.definition.command,statementCount:capture.definition.statementCount,fingerprint:capture.fingerprint,productionEnabled:false},store=createMutationTemplateStore({candidates:[candidate]});
    try{await store.load(candidate.templateId);alreadyStored=true;}catch{await store.save(candidate.templateId,capture.envelope);}await store.load(candidate.templateId);encryptedTemplateStored=true;
  }
  stage="store-sanitized-metadata";const metadataPath=path.join(root,`domestic-report-upload-${kind}.json`),metadata={schemaVersion:1,status:"captured",kind,templateId:capture.definition?.templateId??null,command:capture.definition?.command??capture.command,statementCount:capture.definition?.statementCount??null,fingerprint:capture.fingerprint??null,endpointVerified:capture.endpoint!==undefined?capture.endpoint==="https://mssql2.easypnp.co.kr:8443/servlet/UploadExecute":true,statementTables:capture.statementTables??null,fieldOrder:capture.fieldOrder??null,filePartName:capture.filePartName??null,filePartContentType:capture.filePartContentType??null,plaintextStored:false,productionEnabled:false};
  try{await writeFile(metadataPath,JSON.stringify(metadata),{flag:"wx",mode:0o600});}catch(error){
    if(error?.code!=="EEXIST")throw error;const existing=JSON.parse(await readFile(metadataPath,"utf8"));
    if(JSON.stringify(existing)===JSON.stringify(metadata)){}
    else if(kind==="file-transfer"&&Object.keys(metadata).every(key=>key==="filePartContentType"||JSON.stringify(existing[key])===JSON.stringify(metadata[key]))){await writeFile(metadataPath,JSON.stringify(metadata),{mode:0o600});}
    else throw new Error();
  }
  console.log(JSON.stringify({status:"domestic-report-upload-request-captured",kind,templateId:metadata.templateId,statementCount:metadata.statementCount,statementTables:metadata.statementTables,fieldOrder:metadata.fieldOrder,filePartContentType:metadata.filePartContentType,encryptedTemplateStored,alreadyStored,plaintextStored:false,rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));
}catch(error){
  console.error(JSON.stringify({status:"domestic-report-upload-request-rejected",kind:allowedKinds.has(kind)?kind:null,failureStage:stage,failureCode:typeof error?.code==="string"?error.code:"CAPTURE_FAILED",rawValuesReturned:false,plaintextStored:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;
}finally{chunks.forEach(chunk=>chunk.fill(0));raw=null;}
