import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixedReadClient } from "./protocol/fixed-read-client.mjs";
import { createHttpsTransport } from "./protocol/https-transport.mjs";
import { createAuthenticationTransport } from "./protocol/authentication-transport.mjs";
import { createTemplateStore } from "./security/template-store.mjs";
import { createAuthenticationTemplateStore } from "./security/authentication-template-store.mjs";
import { createVerifiedAuthenticationAdapter } from "./security/authentication-adapter.mjs";
import { createSessionProvider } from "./security/session-provider.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"live-p261793-progress-attempt.v1.json");
let claimed=false,startedAt,stage="preflight";
const classify=error=>{const code=typeof error?.code==="string"?error.code:"UNCLASSIFIED_FAILURE";if(["FIXED_TEMPLATE_REJECTED","TEMPLATE_NOT_ENABLED","CAPTURE_MATTER_MISMATCH","POLICY_REJECTED"].includes(code))return{stage:"preflight",code};if(code==="SESSION_PROVIDER_FAILED")return{stage:"authentication",code};if(["INVALID_REQUEST","REQUEST_TIMEOUT","RESPONSE_ERROR","RESPONSE_ABORTED","SESSION_REQUIRED","UNEXPECTED_HTTP_STATUS","UNEXPECTED_RESPONSE_TYPE","UNSUPPORTED_RESPONSE_ENCODING","RESPONSE_TOO_LARGE","RESPONSE_LENGTH_MISMATCH","INVALID_RESPONSE_UTF8","NETWORK_OR_TLS_ERROR"].includes(code))return{stage:"read-transport",code};if(["RESULTSET_REJECTED","CREDENTIAL_COLUMNS_REJECTED","RESPONSE_SCHEMA_MISMATCH","RESPONSE_MATTER_MISMATCH"].includes(code))return{stage:"read-response",code};return{stage,code:"UNCLASSIFIED_FAILURE"};};

try{
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8"));
  const basePolicy=readJson("../config/safety-policy.json"),baseRegistry=readJson("../config/read-template-registry.json"),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json"),authConfig=readJson("../config/authentication-template.json"),authVerification=readJson("../config/protocol-observations/authentication-live-verification.json");
  const candidate=fingerprints.candidates.find(item=>item.templateId==="matter-detail.progress-records.v1"),registry=structuredClone(baseRegistry),policy=structuredClone(basePolicy),progress=registry.templates.find(item=>item.templateId===candidate?.templateId);
  if(candidate?.sessionId!==174||candidate.productionEnabled!==false||!candidate.fingerprint||progress?.enabled!==false||progress.fingerprint!==null||progress.responseVerification?.mode!=="statement-literal-all-rows"||progress.expectedResponseColumns?.length!==55)throw new Error();
  Object.assign(progress,{fingerprint:candidate.fingerprint,boundMatterReference:"P261793",enabled:true,status:"ephemeral-one-time-progress-validation"});
  if(!policy.allowedOperations.includes("list-progress"))policy.allowedOperations.push("list-progress");
  policy.directReadConstraints["list-progress"].enabledTemplateIds=[progress.templateId];policy.directReadConstraints["list-progress"].boundMatterReferences=["P261793"];
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"list-progress",matterReference:"P261793",templateId:progress.templateId,startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const store=createTemplateStore({candidates:fingerprints.candidates}),adapter=createVerifiedAuthenticationAdapter({verification:authVerification,templateStore:createAuthenticationTemplateStore({expectedFingerprint:authConfig.fingerprint}),expectedFingerprint:authConfig.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),client=createFixedReadClient({policy,registry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie,transport:createHttpsTransport()});
  stage="authentication-and-read";let result=await client.read({templateId:progress.templateId,matterReference:"P261793"});
  const safe={status:"live-progress-read-validated",matterReference:result.matterReference,templateId:result.templateId,rowCount:result.rows.length,columnCount:result.columns.length,allRowsIdentityMatched:true,responseIdentityColumn:"idx_parent",schemaMatched:true,rawRowValuesReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionTemplateEnabled:false};
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"list-progress",matterReference:"P261793",templateId:progress.templateId,startedAt,completedAt:new Date().toISOString(),rowCount:result.rows.length,allRowsIdentityMatched:true,schemaMatched:true}),{mode:0o600});result=null;console.log(JSON.stringify(safe));
}catch(error){const failure=classify(error);if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"list-progress",matterReference:"P261793",templateId:"matter-detail.progress-records.v1",startedAt,completedAt:new Date().toISOString(),failureStage:failure.stage,failureCode:failure.code}),{mode:0o600});}catch{}}console.error(JSON.stringify({status:"live-progress-read-failed",failureStage:failure.stage,failureCode:failure.code,automaticRetryPerformed:false,rawValuesReturned:false}));process.exitCode=1;}
