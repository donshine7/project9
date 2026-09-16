import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixedReadClient } from "./protocol/fixed-read-client.mjs";
import { createHttpsTransport } from "./protocol/https-transport.mjs";
import { createAuthenticationTransport } from "./protocol/authentication-transport.mjs";
import { inspectDocumentListEvidence } from "./protocol/document-list.mjs";
import { createTemplateStore } from "./security/template-store.mjs";
import { createAuthenticationTemplateStore } from "./security/authentication-template-store.mjs";
import { createVerifiedAuthenticationAdapter } from "./security/authentication-adapter.mjs";
import { createSessionProvider } from "./security/session-provider.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"live-p261793-documents-attempt.v1.json");
let claimed=false,startedAt,stage="preflight";
const classify=error=>{const code=typeof error?.code==="string"?error.code:"UNCLASSIFIED_FAILURE";if(["FIXED_TEMPLATE_REJECTED","TEMPLATE_NOT_ENABLED","CAPTURE_MATTER_MISMATCH","POLICY_REJECTED"].includes(code))return{stage:"preflight",code};if(code==="SESSION_PROVIDER_FAILED")return{stage:"authentication",code};if(["INVALID_REQUEST","REQUEST_TIMEOUT","RESPONSE_ERROR","RESPONSE_ABORTED","SESSION_REQUIRED","UNEXPECTED_HTTP_STATUS","UNEXPECTED_RESPONSE_TYPE","UNSUPPORTED_RESPONSE_ENCODING","RESPONSE_TOO_LARGE","RESPONSE_LENGTH_MISMATCH","INVALID_RESPONSE_UTF8","NETWORK_OR_TLS_ERROR"].includes(code))return{stage:"read-transport",code};if(["RESULTSET_REJECTED","CREDENTIAL_COLUMNS_REJECTED","RESPONSE_SCHEMA_MISMATCH","RESPONSE_MATTER_MISMATCH","RESPONSE_PREDICATE_SET_MISMATCH"].includes(code))return{stage:"read-response",code};return{stage,code:"UNCLASSIFIED_FAILURE"};};

try{
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8")),basePolicy=readJson("../config/safety-policy.json"),baseRegistry=readJson("../config/read-template-registry.json"),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json"),authConfig=readJson("../config/authentication-template.json"),authVerification=readJson("../config/protocol-observations/authentication-live-verification.json"),candidate=fingerprints.candidates.find(item=>item.sessionId===247),registry=structuredClone(baseRegistry),policy=structuredClone(basePolicy),documentTemplate=registry.templates.find(item=>item.templateId===candidate?.templateId);
  if(!candidate?.fingerprint||candidate.productionEnabled!==false||documentTemplate?.enabled!==false||documentTemplate.fingerprint!==null||documentTemplate.expectedResponseColumns?.length!==27||documentTemplate.responsePredicateSetVerification?.columns?.length!==4)throw new Error();
  Object.assign(documentTemplate,{fingerprint:candidate.fingerprint,boundMatterReference:"P261793",enabled:true,status:"ephemeral-one-time-document-validation"});
  if(!policy.allowedOperations.includes("list-documents"))policy.allowedOperations.push("list-documents");policy.directReadConstraints["list-documents"].enabledTemplateIds=[documentTemplate.templateId];policy.directReadConstraints["list-documents"].boundMatterReferences=["P261793"];
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"list-documents",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const store=createTemplateStore({candidates:fingerprints.candidates}),adapter=createVerifiedAuthenticationAdapter({verification:authVerification,templateStore:createAuthenticationTemplateStore({expectedFingerprint:authConfig.fingerprint}),expectedFingerprint:authConfig.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),client=createFixedReadClient({policy,registry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie,transport:createHttpsTransport()});
  stage="authentication-and-read";let result=await client.read({templateId:documentTemplate.templateId,matterReference:"P261793"});stage="business-evidence";const evidence=inspectDocumentListEvidence(result);
  const safe={status:"live-document-list-validated",...evidence,exactResponseSchemaMatched:true,fixedPredicateSetMatched:true,automaticRetryPerformed:false,serverMutationPerformed:false,productionTemplateEnabled:false};
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"list-documents",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),rowCount:evidence.rowCount,matterFilenameEvidenceCount:evidence.matterFilenameEvidenceCount}),{mode:0o600});result=null;console.log(JSON.stringify(safe));
}catch(error){const failure=classify(error);if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"list-documents",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),failureStage:failure.stage,failureCode:failure.code}),{mode:0o600});}catch{}}console.error(JSON.stringify({status:"live-document-list-failed",failureStage:failure.stage,failureCode:failure.code,automaticRetryPerformed:false,rawValuesReturned:false}));process.exitCode=1;}
