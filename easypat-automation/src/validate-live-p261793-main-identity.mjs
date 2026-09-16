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

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const attempt=path.join(root,"live-p261793-main-identity-attempt.v3.json");
let claimed=false,startedAt,stage="preflight";
const classify=error=>{
  const code=typeof error?.code==="string"?error.code:"UNCLASSIFIED_FAILURE";
  if(code==="FIXED_TEMPLATE_REJECTED"||code==="TEMPLATE_NOT_ENABLED"||code==="CAPTURE_MATTER_MISMATCH"||code==="POLICY_REJECTED")return{stage:"preflight",code};
  if(code==="SESSION_PROVIDER_FAILED")return{stage:"authentication",code};
  if(["INVALID_REQUEST","REQUEST_TIMEOUT","RESPONSE_ERROR","RESPONSE_ABORTED","SESSION_REQUIRED","UNEXPECTED_HTTP_STATUS","UNEXPECTED_RESPONSE_TYPE","UNSUPPORTED_RESPONSE_ENCODING","RESPONSE_TOO_LARGE","RESPONSE_LENGTH_MISMATCH","INVALID_RESPONSE_UTF8","NETWORK_OR_TLS_ERROR"].includes(code))return{stage:"read-transport",code};
  if(["RESULTSET_REJECTED","CREDENTIAL_COLUMNS_REJECTED","RESPONSE_MATTER_MISMATCH"].includes(code))return{stage:"read-response",code};
  return{stage,code:"UNCLASSIFIED_FAILURE"};
};

try{
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8"));
  const policy=readJson("../config/safety-policy.json"),baseRegistry=readJson("../config/read-template-registry.json"),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json"),authConfig=readJson("../config/authentication-template.json"),authVerification=readJson("../config/protocol-observations/authentication-live-verification.json"),identityEvidence=readJson("../config/protocol-observations/response-identity-preflight.json");
  const candidate=fingerprints.candidates.find(item=>item.templateId==="matter-detail.main-record.v1"),configured=baseRegistry.templates.find(item=>item.templateId==="matter-detail.main-record.v1");
  if(identityEvidence.status!=="offline-preflight-passed-production-disabled"||identityEvidence.productionEnabled!==false||candidate?.productionEnabled!==false||configured?.enabled!==false||configured?.fingerprint!==null||!candidate?.fingerprint)throw new Error();
  const registry=structuredClone(baseRegistry),ephemeralPolicy=structuredClone(policy),main=registry.templates.find(item=>item.templateId==="matter-detail.main-record.v1");
  Object.assign(main,{fingerprint:candidate.fingerprint,boundMatterReference:"P261793",enabled:true,status:"ephemeral-one-time-identity-validation"});
  ephemeralPolicy.directReadConstraints["get-matter-detail"].enabledTemplateIds=[main.templateId];
  ephemeralPolicy.directReadConstraints["get-matter-detail"].boundMatterReferences=["P261793"];
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",matterReference:"P261793",templateId:main.templateId,startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const store=createTemplateStore({candidates:fingerprints.candidates});
  const adapter=createVerifiedAuthenticationAdapter({verification:authVerification,templateStore:createAuthenticationTemplateStore({expectedFingerprint:authConfig.fingerprint}),expectedFingerprint:authConfig.fingerprint,transport:createAuthenticationTransport()});
  const session=createSessionProvider({adapter});
  const client=createFixedReadClient({policy:ephemeralPolicy,registry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie,transport:createHttpsTransport()});
  stage="authentication-and-read";
  let result=await client.read({templateId:main.templateId,matterReference:"P261793"});
  const row=result.rows[0],nonEmptyFieldCount=result.columns.filter(column=>row[column]!==null&&row[column]!=="").length;
  const safe={status:"live-main-identity-read-validated",matterReference:result.matterReference,templateId:result.templateId,rowCount:result.rows.length,columnCount:result.columns.length,columns:result.columns,nonEmptyFieldCount,responseIdentityMatched:true,responseIdentityColumn:"idx",rawRowValuesReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionTemplateEnabled:false};
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",matterReference:"P261793",templateId:main.templateId,startedAt,completedAt:new Date().toISOString(),responseIdentityMatched:true}),{mode:0o600});result=null;console.log(JSON.stringify(safe));
}catch(error){const failure=classify(error);if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",matterReference:"P261793",templateId:"matter-detail.main-record.v1",startedAt,completedAt:new Date().toISOString(),failureStage:failure.stage,failureCode:failure.code}),{mode:0o600});}catch{}}console.error(JSON.stringify({status:"live-main-identity-read-failed",failureStage:failure.stage,failureCode:failure.code,automaticRetryPerformed:false,rawValuesReturned:false}));process.exitCode=1;}
