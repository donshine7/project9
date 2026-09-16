import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixedReadClient } from "./protocol/fixed-read-client.mjs";
import { createHttpsTransport } from "./protocol/https-transport.mjs";
import { createAuthenticationTransport } from "./protocol/authentication-transport.mjs";
import { diagnoseDocumentListEvidence } from "./protocol/document-list.mjs";
import { createTemplateStore } from "./security/template-store.mjs";
import { createAuthenticationTemplateStore } from "./security/authentication-template-store.mjs";
import { createVerifiedAuthenticationAdapter } from "./security/authentication-adapter.mjs";
import { createSessionProvider } from "./security/session-provider.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"diagnose-p261793-documents-attempt.v1.json");let claimed=false,startedAt;
try{
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8")),policy=structuredClone(readJson("../config/safety-policy.json")),registry=structuredClone(readJson("../config/read-template-registry.json")),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json"),authConfig=readJson("../config/authentication-template.json"),authVerification=readJson("../config/protocol-observations/authentication-live-verification.json"),candidate=fingerprints.candidates.find(item=>item.sessionId===247),documentTemplate=registry.templates.find(item=>item.templateId===candidate?.templateId);
  if(!candidate?.fingerprint||candidate.productionEnabled!==false||documentTemplate?.enabled!==false||documentTemplate.fingerprint!==null)throw new Error();Object.assign(documentTemplate,{fingerprint:candidate.fingerprint,boundMatterReference:"P261793",enabled:true,status:"ephemeral-diagnostic"});
  if(!policy.allowedOperations.includes("list-documents"))policy.allowedOperations.push("list-documents");policy.directReadConstraints["list-documents"].enabledTemplateIds=[documentTemplate.templateId];policy.directReadConstraints["list-documents"].boundMatterReferences=["P261793"];
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"diagnose-document-list",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const store=createTemplateStore({candidates:fingerprints.candidates}),adapter=createVerifiedAuthenticationAdapter({verification:authVerification,templateStore:createAuthenticationTemplateStore({expectedFingerprint:authConfig.fingerprint}),expectedFingerprint:authConfig.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),client=createFixedReadClient({policy,registry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie,transport:createHttpsTransport()});let result=await client.read({templateId:documentTemplate.templateId,matterReference:"P261793"});const diagnostic=diagnoseDocumentListEvidence(result);await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"diagnose-document-list",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),rowCount:diagnostic.rowCount}),{mode:0o600});result=null;console.log(JSON.stringify({status:"document-list-safe-diagnostic",...diagnostic,automaticRetryPerformed:false,serverMutationPerformed:false,productionTemplateEnabled:false}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"diagnose-document-list",matterReference:"P261793",startedAt,completedAt:new Date().toISOString()}),{mode:0o600});}catch{}}console.error(JSON.stringify({status:"document-list-diagnostic-failed",rawValuesReturned:false,automaticRetryPerformed:false}));process.exitCode=1;}
