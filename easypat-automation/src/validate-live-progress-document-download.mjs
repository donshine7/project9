import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {lstat,mkdir,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validateProtocolIntent} from "./core.mjs";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {createGenericDocumentDownloader} from "./protocol/generic-document-downloader.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./protocol/https-transport.mjs";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";
import {createProgressDocumentLookup} from "./protocol/progress-document-lookup.mjs";
import {createReadOnlyBatch} from "./protocol/read-only-guard.mjs";
import {parseResultset} from "./protocol/resultset.mjs";
import {createVerifiedAuthenticationAdapter} from "./security/authentication-adapter.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {createSessionProvider} from "./security/session-provider.mjs";
import {createTemplateStore} from "./security/template-store.mjs";
import {getEasyPatCredentialStatus} from "./security/windows-secrets.mjs";

const readJson=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
const attemptRoot=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));

function input(argv){
  if(argv.length!==8||argv[0]!=="--matter-reference"||argv[2]!=="--progress-document"||argv[4]!=="--position"||argv[6]!=="--expected-file-name")throw new Error("INPUT_REJECTED");
  const matterReference=normalizeExactMatterReference(argv[1]),progressDocument=argv[3],position=Number(argv[5]),expectedFileName=argv[7];
  if(typeof progressDocument!=="string"||!progressDocument.length||progressDocument.length>512||progressDocument!==progressDocument.trim()||/[^\P{Cc}\t\r\n]|[\p{Cs}]/u.test(progressDocument)||
     !Number.isSafeInteger(position)||position<1||position>500||typeof expectedFileName!=="string"||!expectedFileName.length||expectedFileName.length>260||/[\p{Cc}\p{Cs}\\/:*?"<>|]/u.test(expectedFileName))throw new Error("INPUT_REJECTED");
  return{matterReference,progressDocument,position,expectedFileName};
}

let matterReference,progressDocument,position,expectedFileName,attempt,startedAt,claimed=false,stage="input",businessReadRequestCount=0;
try{
  ({matterReference,progressDocument,position,expectedFileName}=input(process.argv.slice(2)));
  const generic=readJson("../config/generic-read-template-registry.json"),fixed=readJson("../config/read-template-registry.json"),policy=readJson("../config/safety-policy.json");
  if(!policy.genericDownloadConstraints?.authorizedValidationMatterReferences?.includes(matterReference)||policy.mutationOperationsEnabled!==false||policy.arbitrarySqlEnabled!==false||policy.tlsVerificationRequired!==true)throw new Error("PREFLIGHT_REJECTED");
  const genericDefinition=id=>structuredClone(generic.templates.find(template=>template.templateId===id)),fixedDefinition=id=>structuredClone(fixed.templates.find(template=>template.templateId===id));
  const countDefinition=genericDefinition("matter-search.exact-count.v1"),searchDefinition=genericDefinition("matter-search.exact-result.v1"),progressDefinition=genericDefinition("matter-detail.progress-records.v1"),fixedDocument=fixedDefinition("matter-detail.documents.v1"),
    intermediateMetadata=readJson("../.local/templates-user/document-group-intermediate-request.v2.json"),intermediateResponse=readJson("../.local/templates-user/document-group-intermediate-response.v2.json"),progressDocumentMetadata=readJson("../.local/templates-user/progress-document-list-request.v1.json");
  if(!countDefinition||!searchDefinition||!progressDefinition||!fixedDocument||intermediateMetadata?.templateId!=="matter-detail.document-group-intermediate.v2"||
     intermediateResponse?.templateId!==intermediateMetadata.templateId||intermediateResponse.requestFingerprint!==intermediateMetadata.fingerprint||intermediateResponse.responseColumns?.length!==55||
     progressDocumentMetadata?.templateId!=="matter-detail.progress-documents.v1"||progressDocumentMetadata.responseColumns?.length!==27||
     JSON.stringify(progressDocumentMetadata.responsePredicateSetVerification)!==JSON.stringify(fixedDocument.responsePredicateSetVerification))throw new Error("PREFLIGHT_REJECTED");
  const intermediateDefinition={templateId:intermediateMetadata.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:intermediateMetadata.fingerprint,parameterization:{mode:"single-scalar-equality",source:"trusted-derived-identity",predicateColumn:"idx"},responseVerification:{mode:"statement-literal-equality",predicateColumn:"idx",responseColumn:"idx"},expectedResponseColumns:[...intermediateResponse.responseColumns]};
  const documentDefinition={templateId:progressDocumentMetadata.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:progressDocumentMetadata.fingerprint,parameterization:{mode:"scalar-equality-as-literal",source:"trusted-derived-identity",predicateColumn:"GRP_KEY"},responsePredicateSetVerification:structuredClone(progressDocumentMetadata.responsePredicateSetVerification),expectedResponseColumns:[...progressDocumentMetadata.responseColumns]};
  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates,store=createTemplateStore({candidates:[...candidates,intermediateMetadata,progressDocumentMetadata]});
  const authenticationTemplate=readJson("../config/authentication-template.json"),authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json"),authStore=createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint});
  stage="preflight";const credentialStatus=await getEasyPatCredentialStatus();if(!credentialStatus.available||!credentialStatus.usernamePresent||!credentialStatus.passwordPresent)throw new Error("PREFLIGHT_REJECTED");
  await Promise.all([countDefinition.templateId,searchDefinition.templateId,progressDefinition.templateId,intermediateDefinition.templateId,documentDefinition.templateId].map(id=>store.load(id)));await authStore.load();
  await mkdir(attemptRoot,{recursive:true});if((await lstat(attemptRoot)).isSymbolicLink()||path.resolve(await realpath(attemptRoot)).toLowerCase()!==attemptRoot.toLowerCase())throw new Error("PREFLIGHT_REJECTED");
  const attemptKey=createHash("sha256").update(`${matterReference}\0${progressDocument}\0${position}\0${expectedFileName}`,"utf8").digest("hex");attempt=path.join(attemptRoot,`live-progress-document-download-${attemptKey}.v2.json`);startedAt=new Date().toISOString();
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"progress-document-download",matterReference,progressDocument,position,expectedFileName,startedAt}),{flag:"wx",mode:0o600});claimed=true;

  const adapter=createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:authStore,expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),transport=createHttpsTransport();
  const roles=new Map([["count-results",["search-matter",countDefinition.templateId]],["fetch-result-rows",["search-matter",searchDefinition.templateId]],["progress-records",["list-progress",progressDefinition.templateId]],["document-group-record",["list-documents",intermediateDefinition.templateId]],["progress-document-records",["list-documents",documentDefinition.templateId]]]);
  const executeRead=async({operation,role,envelope})=>{const expected=roles.get(role);if(!expected||expected[0]!==operation||expected[1]!==envelope?.templateId)throw new Error("READ_REJECTED");stage=`read-${role}`;validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);let cookie,body,response;try{cookie=await session.getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();businessReadRequestCount++;response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("READ_REJECTED");const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}finally{cookie=null;body=null;response=null;}};
  const lookup=createProgressDocumentLookup({countDefinition,searchDefinition,progressDefinition,intermediateDefinition,documentDefinition,loadTemplate:store.load,executeRead});
  const validationPolicy=structuredClone(policy);Object.assign(validationPolicy.genericDownloadConstraints,{enabled:true,mcpExposureEnabled:true,sourceTemplateId:documentDefinition.templateId});
  const downloader=createGenericDocumentDownloader({policy:validationPolicy,prepareDownload:({matterReference:verifiedMatter,position:verifiedPosition,expectedFileName:verifiedFile})=>lookup.prepareDownload({matterReference:verifiedMatter,progressDocument,position:verifiedPosition,expectedFileName:verifiedFile}),getSessionCookie:session.getSessionCookie});
  stage="download";const result=await downloader.download({matterReference,position,expectedFileName});
  if(businessReadRequestCount!==5||result.contentType!=="application/pdf"||!/^[a-f0-9]{64}$/.test(result.sha256))throw new Error("VALIDATION_REJECTED");
  const bytes=await readFile(result.path);if(bytes.length!==result.fileSizeBytes||bytes.subarray(0,5).toString("ascii")!=="%PDF-")throw new Error("VALIDATION_REJECTED");bytes.fill(0);
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"progress-document-download",matterReference,progressDocument,position,expectedFileName,startedAt,completedAt:new Date().toISOString(),businessReadRequestCount,fileSizeBytes:result.fileSizeBytes,contentType:result.contentType,sha256:result.sha256}),{mode:0o600});
  console.log(JSON.stringify({status:"live-progress-document-download-validated",matterReference,progressDocument,position,fileName:result.fileName,fileSizeBytes:result.fileSizeBytes,contentType:result.contentType,sha256:result.sha256,localPath:result.path,businessReadRequestCount,pdfMagicVerified:true,downloaded:result.downloaded,alreadyPresent:result.alreadyPresent,overwritten:false,automaticRetryPerformed:false,serverMutationPerformed:false,serverUploadPathReturned:false,productionEnabled:false,mcpExposureEnabled:false}));
}catch{
  if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"progress-document-download",matterReference,progressDocument,position,expectedFileName,startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-progress-document-download-failed",failureStage:stage,rawValuesReturned:false,serverUploadPathReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));process.exitCode=1;
}
