import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validateProtocolIntent} from "./core.mjs";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./protocol/https-transport.mjs";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";
import {createProgressDocumentLookup} from "./protocol/progress-document-lookup.mjs";
import {createReadOnlyBatch} from "./protocol/read-only-guard.mjs";
import {parseResultset} from "./protocol/resultset.mjs";
import {compileResponsePredicateSet,verifyResponsePredicateSet} from "./protocol/response-predicate-set.mjs";
import {createVerifiedAuthenticationAdapter} from "./security/authentication-adapter.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {createSessionProvider} from "./security/session-provider.mjs";
import {createTemplateStore} from "./security/template-store.mjs";
import {getEasyPatCredentialStatus} from "./security/windows-secrets.mjs";

const readJson=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
function input(argv){
  if(argv.length!==4||argv[0]!=="--matter-reference"||argv[2]!=="--progress-document")throw new Error("INPUT_REJECTED");
  const matterReference=normalizeExactMatterReference(argv[1]),progressDocument=argv[3];
  if(typeof progressDocument!=="string"||!progressDocument.length||progressDocument.length>512||progressDocument!==progressDocument.trim()||/[\p{Cc}\p{Cs}]/u.test(progressDocument))throw new Error("INPUT_REJECTED");
  return{matterReference,progressDocument};
}

let matterReference,progressDocument,attempt,claimed=false,startedAt,stage="input",lastReadDiagnostic;
try{
  ({matterReference,progressDocument}=input(process.argv.slice(2)));
  const generic=readJson("../config/generic-read-template-registry.json"),fixed=readJson("../config/read-template-registry.json"),policy=readJson("../config/safety-policy.json");
  if(!policy.genericDownloadConstraints?.authorizedValidationMatterReferences?.includes(matterReference)||policy.mutationOperationsEnabled!==false||
     policy.arbitrarySqlEnabled!==false||policy.tlsVerificationRequired!==true)throw new Error("PREFLIGHT_REJECTED");
  const genericDefinition=id=>structuredClone(generic.templates.find(template=>template.templateId===id));
  const fixedDefinition=id=>structuredClone(fixed.templates.find(template=>template.templateId===id));
  const countDefinition=genericDefinition("matter-search.exact-count.v1"),searchDefinition=genericDefinition("matter-search.exact-result.v1"),
    progressDefinition=genericDefinition("matter-detail.progress-records.v1"),fixedDocument=fixedDefinition("matter-detail.documents.v1"),
    intermediateMetadata=readJson("../.local/templates-user/document-group-intermediate-request.v2.json"),
    intermediateResponse=readJson("../.local/templates-user/document-group-intermediate-response.v2.json"),
    progressDocumentMetadata=readJson("../.local/templates-user/progress-document-list-request.v1.json");
  if(!countDefinition||!searchDefinition||!progressDefinition||!fixedDocument||fixedDocument.enabled!==true||
     intermediateMetadata?.templateId!=="matter-detail.document-group-intermediate.v2"||intermediateMetadata.command!=="SELECT"||
     intermediateMetadata.statementCount!==1||intermediateMetadata.productionEnabled!==false||
     intermediateResponse?.templateId!==intermediateMetadata.templateId||
     intermediateResponse.requestFingerprint!==intermediateMetadata.fingerprint||
     !Array.isArray(intermediateResponse.responseColumns)||intermediateResponse.responseColumns.length!==55||
     progressDocumentMetadata?.templateId!=="matter-detail.progress-documents.v1"||progressDocumentMetadata.command!=="SELECT"||
     progressDocumentMetadata.statementCount!==1||progressDocumentMetadata.productionEnabled!==false||
     !Array.isArray(progressDocumentMetadata.responseColumns)||progressDocumentMetadata.responseColumns.length!==27||
     JSON.stringify(progressDocumentMetadata.responsePredicateSetVerification)!==JSON.stringify(fixedDocument.responsePredicateSetVerification))throw new Error("PREFLIGHT_REJECTED");
  const intermediateDefinition={
    templateId:intermediateMetadata.templateId,command:"SELECT",statementCount:1,productionEnabled:false,
    baseFingerprint:intermediateMetadata.fingerprint,
    parameterization:{mode:"single-scalar-equality",source:"trusted-derived-identity",predicateColumn:"idx"},
    responseVerification:{mode:"statement-literal-equality",predicateColumn:"idx",responseColumn:"idx"},
    expectedResponseColumns:[...intermediateResponse.responseColumns],
  };
  const documentDefinition={
    templateId:progressDocumentMetadata.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:progressDocumentMetadata.fingerprint,
    parameterization:{mode:"scalar-equality-as-literal",source:"trusted-derived-identity",predicateColumn:"GRP_KEY"},
    responsePredicateSetVerification:structuredClone(progressDocumentMetadata.responsePredicateSetVerification),
    expectedResponseColumns:[...progressDocumentMetadata.responseColumns],
  };

  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates;
  const store=createTemplateStore({candidates:[...candidates,intermediateMetadata,progressDocumentMetadata]});
  const authenticationTemplate=readJson("../config/authentication-template.json"),authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json");
  const authStore=createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint});
  stage="preflight";
  const credentialStatus=await getEasyPatCredentialStatus();
  if(!credentialStatus.available||!credentialStatus.usernamePresent||!credentialStatus.passwordPresent)throw new Error("PREFLIGHT_REJECTED");
  await Promise.all([countDefinition.templateId,searchDefinition.templateId,progressDefinition.templateId,intermediateDefinition.templateId,documentDefinition.templateId].map(id=>store.load(id)));
  await authStore.load();
  await mkdir(root,{recursive:true});
  if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error("PREFLIGHT_REJECTED");
  const attemptKey=createHash("sha256").update(`${matterReference}\0${progressDocument}`,"utf8").digest("hex");
  attempt=path.join(root,`live-progress-documents-${attemptKey}.v9.json`);startedAt=new Date().toISOString();
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"progress-document-list",matterReference,progressDocument,startedAt}),{flag:"wx",mode:0o600});claimed=true;

  const adapter=createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:authStore,expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()});
  const session=createSessionProvider({adapter}),transport=createHttpsTransport();let businessReadRequestCount=0;
  const allowed=new Map([
    ["count-results",["search-matter",countDefinition.templateId]],
    ["fetch-result-rows",["search-matter",searchDefinition.templateId]],
    ["progress-records",["list-progress",progressDefinition.templateId]],
    ["document-group-record",["list-documents",intermediateDefinition.templateId]],
    ["progress-document-records",["list-documents",documentDefinition.templateId]],
  ]);
  const executeRead=async({operation,role,envelope})=>{
    const expected=allowed.get(role);if(!expected||expected[0]!==operation||expected[1]!==envelope?.templateId)throw new Error("READ_REJECTED");
    stage=`read-${role}`;
    validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);
    let cookie,body,response;
    try{
      cookie=await session.getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();
      businessReadRequestCount++;response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});
      if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("READ_REJECTED");
      const parsed=parseResultset(response.text);
      if(role==="progress-document-records"){
        let predicateSetMatched=false;
        try{verifyResponsePredicateSet(parsed,compileResponsePredicateSet(envelope.statements[0],documentDefinition.responsePredicateSetVerification));predicateSetMatched=true;}catch{}
        const required=["DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE"];
        lastReadDiagnostic={role,columnCount:parsed.columns.length,rowCount:parsed.rows.length,exactSchemaMatched:parsed.columns.length===documentDefinition.expectedResponseColumns.length&&documentDefinition.expectedResponseColumns.every((column,index)=>column===parsed.columns[index]),predicateSetMatched,requiredProjectionColumnsPresent:required.every(column=>parsed.columns.includes(column)),rawValuesReturned:false};
      }
      return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};
    }finally{cookie=null;body=null;response=null;}
  };
  const lookup=createProgressDocumentLookup({countDefinition,searchDefinition,progressDefinition,intermediateDefinition,documentDefinition,loadTemplate:store.load,executeRead});
  stage="authentication-and-progress-document-read";
  const result=await lookup.list({matterReference,progressDocument});
  if(result.matterReference!==matterReference||result.progressDocument!==progressDocument||!Number.isInteger(result.count)||businessReadRequestCount!==5)throw new Error("VALIDATION_REJECTED");
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"progress-document-list",matterReference,progressDocument,startedAt,completedAt:new Date().toISOString(),businessReadRequestCount,documentItemCount:result.count}),{mode:0o600});
  console.log(JSON.stringify({status:"live-progress-documents-validated",matterReference,progressDocument,businessReadRequestCount,documentItemCount:result.count,documents:result,progressIdentityBindingVerified:true,intermediateIdentityBindingVerified:true,documentGroupBindingVerified:true,documentGroupSource:"verified-progress-idx-via-intermediate-idx-parent",rawRowsReturned:false,serverUploadPathsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false,mcpExposureEnabled:false}));
}catch(error){
  const allowedCodes=new Set(["PROGRESS_DOCUMENT_INPUT_REJECTED","PROGRESS_DOCUMENT_SEARCH_REJECTED","PROGRESS_DOCUMENT_PROGRESS_REJECTED","PROGRESS_DOCUMENT_GROUP_REJECTED","PROGRESS_DOCUMENT_TEMPLATE_BINDING_REJECTED","PROGRESS_DOCUMENT_RESPONSE_POLICY_REJECTED","PROGRESS_DOCUMENT_READ_REJECTED","PROGRESS_DOCUMENT_RESULT_REJECTED"]);
  const failureCode=allowedCodes.has(error?.code)?error.code:"UNCLASSIFIED_SAFE_FAILURE";
  if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"progress-document-list",matterReference,progressDocument,startedAt,completedAt:new Date().toISOString(),failureStage:stage,failureCode}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-progress-documents-validation-failed",failureStage:stage,failureCode,readDiagnostic:lastReadDiagnostic,rawValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));process.exitCode=1;
}
