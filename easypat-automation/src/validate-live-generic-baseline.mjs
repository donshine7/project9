import { readFileSync } from "node:fs";
import { mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGeneralMatterLookup } from "./protocol/general-matter-lookup.mjs";
import { createReadOnlyBatch } from "./protocol/read-only-guard.mjs";
import { parseResultset } from "./protocol/resultset.mjs";
import { createHttpsTransport, EASYPAT_ENDPOINT } from "./protocol/https-transport.mjs";
import { validateProtocolIntent } from "./core.mjs";
import { createAuthenticationTransport } from "./protocol/authentication-transport.mjs";
import { createTemplateStore } from "./security/template-store.mjs";
import { createAuthenticationTemplateStore } from "./security/authentication-template-store.mjs";
import { createVerifiedAuthenticationAdapter } from "./security/authentication-adapter.mjs";
import { createSessionProvider } from "./security/session-provider.mjs";
import { getEasyPatCredentialStatus } from "./security/windows-secrets.mjs";

const readJson=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const attempt=path.join(root,"live-generic-baseline-attempt.v2.json");
const matterReference="P261793";
let claimed=false,startedAt,stage="preflight";

try{
  const policy=readJson("../config/safety-policy.json");
  const generic=readJson("../config/generic-read-template-registry.json");
  const registry=readJson("../config/read-template-registry.json");
  const mainSchema=readJson("../config/main-record-response-schema.json");
  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates;
  const authenticationTemplate=readJson("../config/authentication-template.json");
  const authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json");
  if(generic.productionEnabled!==false||generic.baselineMatterReference!==matterReference||
     generic.completedDistinctNonBaselineMatterValidations!==0||policy.mutationOperationsEnabled!==false||
     policy.arbitrarySqlEnabled!==false||policy.maxAutomaticLoginAttempts!==1)throw new Error();
  const definition=id=>structuredClone(generic.templates.find(template=>template.templateId===id));
  const countDefinition=definition("matter-search.exact-count.v1"),searchDefinition=definition("matter-search.exact-result.v1"),detailDefinition=definition("matter-detail.main-record.v1");
  const fixedDetail=registry.templates.find(template=>template.templateId==="matter-detail.main-record.v1");
  if(!countDefinition||!searchDefinition||!detailDefinition||mainSchema?.templateId!==detailDefinition.templateId||mainSchema?.columnCount!==205||mainSchema.columns?.length!==205||
     [countDefinition,searchDefinition,detailDefinition].some(item=>item.productionEnabled!==false))throw new Error();
  if(!fixedDetail?.responseVerification||mainSchema.rawRowValuesStored!==false)throw new Error();
  detailDefinition.expectedResponseColumns=[...mainSchema.columns];
  delete detailDefinition.expectedResponseColumnsSource;
  const store=createTemplateStore({candidates});
  const authStore=createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint});
  const credentialStatus=await getEasyPatCredentialStatus();
  if(!credentialStatus.available||!credentialStatus.usernamePresent||!credentialStatus.passwordPresent)throw new Error();
  // Do not consume the one-time live gate until every encrypted dependency is
  // decryptable by the current Windows user.
  await Promise.all([countDefinition.templateId,searchDefinition.templateId,detailDefinition.templateId].map(id=>store.load(id)));
  await authStore.load();
  await mkdir(root,{recursive:true});
  if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  startedAt=new Date().toISOString();
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"generic-baseline-summary",matterReference,startedAt}),{flag:"wx",mode:0o600});
  claimed=true;
  const adapter=createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:authStore,expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()});
  const session=createSessionProvider({adapter}),transport=createHttpsTransport();
  let businessReadRequestCount=0;
  const executeRead=async({operation,role,envelope})=>{
    if(![["search-matter","count-results"],["search-matter","fetch-result-rows"],["get-matter-detail","main-matter-record"]].some(([a,b])=>operation===a&&role===b))throw new Error();
    validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT,operation,mutates:false});
    createReadOnlyBatch([envelope]);
    let cookie,body,response;
    try{
      cookie=await session.getSessionCookie();
      body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();
      businessReadRequestCount++;
      response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});
      if(response?.status!==200||response.contentType!=="text/resultset")throw new Error();
      const parsed=parseResultset(response.text);
      return {templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};
    }finally{cookie=null;body=null;response=null;}
  };
  const lookup=createGeneralMatterLookup({countDefinition,searchDefinition,detailDefinition,loadTemplate:store.load,executeRead});
  stage="authentication-and-generic-read";
  const summary=await lookup.lookupSummary({matterReference});
  if(summary.matterReference!==matterReference||Object.keys(summary).length!==8||businessReadRequestCount!==3)throw new Error();
  const completedAt=new Date().toISOString();
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"generic-baseline-summary",matterReference,startedAt,completedAt,businessReadRequestCount,safeProjectionFieldCount:7}),{mode:0o600});
  console.log(JSON.stringify({status:"live-generic-baseline-validated",matterReference,businessReadRequestCount,safeProjectionFieldCount:7,searchCountExactlyOne:true,searchRowExactlyOne:true,searchMatterReferenceExact:true,detailIdentityMatched:true,rawRowsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false,mcpToolsExpanded:false}));
}catch{
  if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"generic-baseline-summary",matterReference,startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-generic-baseline-failed",failureStage:stage,rawValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));
  process.exitCode=1;
}
