import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import {readFileSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createFixedReadClient} from "./protocol/fixed-read-client.mjs";
import {createHttpsTransport} from "./protocol/https-transport.mjs";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {createDocumentDownloader} from "./protocol/document-downloader.mjs";
import {createTemplateStore} from "./security/template-store.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {createVerifiedAuthenticationAdapter} from "./security/authentication-adapter.mjs";
import {createSessionProvider} from "./security/session-provider.mjs";

const matterReference="P261793";
const position=2;
const expectedFileName="P261545외_수임내역서(수정).jpg";
const attemptRoot=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const attemptPath=path.join(attemptRoot,"live-p261793-download-attempt.v1.json");
let claimed=false,startedAt,stage="preflight";

function classify(error){
  const code=typeof error?.code==="string"?error.code:typeof error?.message==="string"?error.message:"UNCLASSIFIED_FAILURE";
  if(["DOCUMENT_DOWNLOAD_POLICY_REJECTED","DOCUMENT_DOWNLOAD_INPUT_REJECTED","FIXED_TEMPLATE_REJECTED","TEMPLATE_NOT_ENABLED","CAPTURE_MATTER_MISMATCH","POLICY_REJECTED"].includes(code))return{stage:"preflight",code};
  if(["SESSION_PROVIDER_FAILED","AUTOMATIC_LOGIN_FAILED","AUTOMATIC_LOGIN_ATTEMPT_EXHAUSTED"].includes(code))return{stage:"authentication",code};
  if(code.startsWith("DOWNLOAD_")||code==="INVALID_DOWNLOAD_REQUEST")return{stage:"download-transport",code};
  if(["RESULTSET_REJECTED","CREDENTIAL_COLUMNS_REJECTED","RESPONSE_SCHEMA_MISMATCH","RESPONSE_MATTER_MISMATCH","RESPONSE_PREDICATE_SET_MISMATCH"].includes(code))return{stage:"document-list-response",code};
  if(code==="EEXIST")return{stage:"local-save",code:"LOCAL_DESTINATION_EXISTS"};
  return{stage,code:"UNCLASSIFIED_FAILURE"};
}

try{
  const readJson=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
  const policy=structuredClone(readJson("../config/safety-policy.json"));
  const registry=readJson("../config/read-template-registry.json");
  const fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json");
  const authConfig=readJson("../config/authentication-template.json");
  const authVerification=readJson("../config/protocol-observations/authentication-live-verification.json");
  const template=registry.templates.find(item=>item.templateId==="matter-detail.documents.v1");
  if(template?.enabled!==true||template?.boundMatterReference!==matterReference||template?.fingerprint!=="e31186d026569c1063785e8b063eab6a92213025937cb757dbaf53fdc6e87454"||template?.expectedResponseColumns?.length!==27)throw new Error("FIXED_TEMPLATE_REJECTED");
  if(!policy.allowedOperations.includes("download-document"))policy.allowedOperations.push("download-document");
  Object.assign(policy.documentDownloadConstraints,{enabled:true,allowedSelections:[{position,expectedFileName}]});

  await mkdir(attemptRoot,{recursive:true});
  const rootInfo=await lstat(attemptRoot);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||path.resolve(await realpath(attemptRoot)).toLowerCase()!==attemptRoot.toLowerCase())throw new Error("LOCAL_ATTEMPT_PATH_REJECTED");
  startedAt=new Date().toISOString();
  await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"started",operation:"download-document",matterReference,position,expectedFileName,startedAt}),{flag:"wx",mode:0o600});
  claimed=true;

  const store=createTemplateStore({candidates:fingerprints.candidates});
  const adapter=createVerifiedAuthenticationAdapter({verification:authVerification,templateStore:createAuthenticationTemplateStore({expectedFingerprint:authConfig.fingerprint}),expectedFingerprint:authConfig.fingerprint,transport:createAuthenticationTransport()});
  const session=createSessionProvider({adapter});
  const client=createFixedReadClient({policy,registry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie,transport:createHttpsTransport()});
  const downloader=createDocumentDownloader({policy,readDocuments:client.read,getSessionCookie:session.getSessionCookie});
  stage="authentication-list-and-download";
  const result=await downloader.download({matterReference,position,expectedFileName});
  const safe={status:"live-document-download-validated",matterReference,position,fileName:result.fileName,fileSizeBytes:result.fileSizeBytes,contentType:result.contentType,sha256:result.sha256,localPath:result.path,overwritten:result.overwritten,automaticRetryPerformed:result.automaticRetryPerformed,serverMutationPerformed:result.serverMutationPerformed,serverUploadPathReturned:result.serverUploadPathReturned,productionDownloadEnabled:false};
  await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"success",operation:"download-document",matterReference,position,expectedFileName,startedAt,completedAt:new Date().toISOString(),fileSizeBytes:result.fileSizeBytes,contentType:result.contentType,sha256:result.sha256,overwritten:false}),{mode:0o600});
  console.log(JSON.stringify(safe));
}catch(error){
  const failure=classify(error);
  if(claimed){try{await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"failed",operation:"download-document",matterReference,position,expectedFileName,startedAt,completedAt:new Date().toISOString(),failureStage:failure.stage,failureCode:failure.code}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-document-download-failed",failureStage:failure.stage,failureCode:failure.code,automaticRetryPerformed:false,serverMutationPerformed:false,rawServerPathReturned:false}));
  process.exitCode=1;
}
