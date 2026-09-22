import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {lstat,mkdir,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validateProtocolIntent} from "./core.mjs";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {createGeneralDocumentLookup} from "./protocol/general-document-lookup.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./protocol/https-transport.mjs";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";
import {createReadOnlyBatch} from "./protocol/read-only-guard.mjs";
import {parseResultset} from "./protocol/resultset.mjs";
import {createVerifiedAuthenticationAdapter} from "./security/authentication-adapter.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {createSessionProvider} from "./security/session-provider.mjs";
import {createTemplateStore} from "./security/template-store.mjs";
import {getEasyPatCredentialStatus} from "./security/windows-secrets.mjs";

const readJson=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
function inputMatter(argv){if(argv.length!==2||argv[0]!=="--matter-reference")throw new Error("INPUT_REJECTED");return normalizeExactMatterReference(argv[1]);}

let matterReference,attempt,startedAt,claimed=false,stage="input";
try{
  matterReference=inputMatter(process.argv.slice(2));
  const generic=readJson("../config/generic-read-template-registry.json"),policy=readJson("../config/safety-policy.json");
  const validationAuthorized=generic.authorizedNonBaselineMatterReferences?.includes(matterReference)||policy.genericDownloadConstraints?.authorizedValidationMatterReferences?.includes(matterReference);
  if(!validationAuthorized||generic.baselineMatterReference===matterReference||
     policy.genericDocumentConstraints?.enabled!==true||policy.genericDocumentConstraints?.mcpExposureEnabled!==true||
     policy.genericDocumentConstraints?.callerSuppliedGroupKeyAllowed!==false||policy.mutationOperationsEnabled!==false||policy.arbitrarySqlEnabled!==false)throw new Error("PREFLIGHT_REJECTED");
  const definition=id=>structuredClone(generic.templates.find(template=>template.templateId===id));
  const countDefinition=definition("matter-search.exact-count.v1"),searchDefinition=definition("matter-search.exact-result.v1"),documentDefinition=definition("matter-detail.documents.matter-candidate.v1");
  if(!countDefinition||!searchDefinition||!documentDefinition||countDefinition.productionEnabled!==true||searchDefinition.productionEnabled!==true||documentDefinition.productionEnabled!==true||
     documentDefinition.requiredDistinctNonBaselineMatterValidations!==2||documentDefinition.completedDistinctNonBaselineMatterValidations!==2)throw new Error("PREFLIGHT_REJECTED");

  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates,authenticationTemplate=readJson("../config/authentication-template.json"),authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json");
  const store=createTemplateStore({candidates}),authStore=createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint});
  stage="preflight";const credentialStatus=await getEasyPatCredentialStatus();if(!credentialStatus.available||!credentialStatus.usernamePresent||!credentialStatus.passwordPresent)throw new Error("PREFLIGHT_REJECTED");
  const [countEnvelope,searchEnvelope,documentEnvelope,captureMetadata]=await Promise.all([
    store.load(countDefinition.templateId),store.load(searchDefinition.templateId),store.load(documentDefinition.templateId),
    readFile(path.join(root,"matter-document-request-session9.v1.json"),"utf8").then(JSON.parse),
  ]);
  if(captureMetadata?.templateId!==documentDefinition.templateId||captureMetadata.fingerprint!==documentDefinition.baseFingerprint||
     captureMetadata.sourceSessionId!==9||captureMetadata.sourceClassification!=="matter-bound-document-candidate"||
     captureMetadata.matterBindingObserved!==true||captureMetadata.quarantinedGroupBindingObserved!==false||captureMetadata.productionEnabled!==false)throw new Error("PREFLIGHT_REJECTED");
  await authStore.load();countEnvelope.statements.length;searchEnvelope.statements.length;
  await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error("PREFLIGHT_REJECTED");
  const attemptKey=createHash("sha256").update(matterReference,"utf8").digest("hex");attempt=path.join(root,`live-generic-documents-${attemptKey}.v1.json`);startedAt=new Date().toISOString();
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"generic-document-list",matterReference,startedAt}),{flag:"wx",mode:0o600});claimed=true;

  const adapter=createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:authStore,expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),transport=createHttpsTransport();
  let businessReadRequestCount=0;const allowed=new Map([["count-results",["search-matter",countDefinition.templateId]],["fetch-result-rows",["search-matter",searchDefinition.templateId]],["document-records",["list-documents",documentDefinition.templateId]]]);
  const executeRead=async({operation,role,envelope})=>{
    const expected=allowed.get(role);if(!expected||expected[0]!==operation||expected[1]!==envelope?.templateId)throw new Error("READ_REJECTED");
    validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);
    let cookie,body,response;
    try{cookie=await session.getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();businessReadRequestCount++;response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("READ_REJECTED");const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}
    finally{cookie=null;body=null;response=null;}
  };
  const lookup=createGeneralDocumentLookup({countDefinition,searchDefinition,documentDefinition,loadTemplate:store.load,executeRead});stage="authentication-and-generic-document-read";
  const result=await lookup.list({matterReference});if(result.matterReference!==matterReference||!Number.isInteger(result.count)||result.count<0||businessReadRequestCount!==3)throw new Error("VALIDATION_REJECTED");
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"generic-document-list",matterReference,startedAt,completedAt:new Date().toISOString(),businessReadRequestCount,documentItemCount:result.count,safeProjectionFieldCount:5}),{mode:0o600});
  console.log(JSON.stringify({status:"live-generic-documents-validated",matterReference,businessReadRequestCount,documentItemCount:result.count,documents:result,safeProjectionFieldCount:5,matterIdentityBindingVerified:true,exactResponseSchemaVerified:true,rawRowsReturned:false,serverUploadPathsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:true,mcpExposureEnabled:true}));
}catch{
  if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"generic-document-list",matterReference,startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-generic-documents-validation-failed",failureStage:stage,rawValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));process.exitCode=1;
}
