import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validateProtocolIntent} from "./core.mjs";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./protocol/https-transport.mjs";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";
import {bindMatterIdentityDetailTemplate,bindMatterReferenceSearchTemplate,createMatterIdentityContext,readMatterSearchCandidateCount} from "./protocol/parameterized-read-template.mjs";
import {createReadOnlyBatch} from "./protocol/read-only-guard.mjs";
import {inspectRelatedCountsBinding} from "./protocol/related-counts-binding.mjs";
import {parseResultset} from "./protocol/resultset.mjs";
import {createVerifiedAuthenticationAdapter} from "./security/authentication-adapter.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {createSessionProvider} from "./security/session-provider.mjs";
import {createTemplateStore} from "./security/template-store.mjs";
import {getEasyPatCredentialStatus} from "./security/windows-secrets.mjs";

const readJson=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),EXPECTED=["진행수","연차수","신규성수","연구과제수","우선권수","첨부수","업무관리수","청구수","메모수","메일발송수"];
function inputMatter(argv){if(argv.length!==2||argv[0]!=="--matter-reference")throw new Error("INPUT_REJECTED");return normalizeExactMatterReference(argv[1]);}
let matterReference,attempt,startedAt,claimed=false,stage="input";
try{
  matterReference=inputMatter(process.argv.slice(2));const generic=readJson("../config/generic-read-template-registry.json"),policy=readJson("../config/safety-policy.json");
  if(!policy.genericDownloadConstraints?.authorizedValidationMatterReferences?.includes(matterReference)||policy.mutationOperationsEnabled!==false||policy.arbitrarySqlEnabled!==false)throw new Error("PREFLIGHT_REJECTED");
  const definition=id=>structuredClone(generic.templates.find(template=>template.templateId===id)),countDefinition=definition("matter-search.exact-count.v1"),searchDefinition=definition("matter-search.exact-result.v1");
  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates,relatedCandidate=candidates.find(item=>item.templateId==="matter-detail.related-counts.v1");
  if(!countDefinition||!searchDefinition||!relatedCandidate||countDefinition.productionEnabled!==true||searchDefinition.productionEnabled!==true)throw new Error("PREFLIGHT_REJECTED");
  const relatedDefinition={templateId:relatedCandidate.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:relatedCandidate.fingerprint,parameterization:{mode:"multi-scalar-equality",source:"verified-search-identity",predicateColumns:["idx_parent","GRP_KEY","idx_data"],expectedOccurrenceCounts:{idx_parent:11,GRP_KEY:1,idx_data:1},sourceTemplateId:searchDefinition.templateId,sourceColumn:searchDefinition.responseIdentityColumn}};
  const authenticationTemplate=readJson("../config/authentication-template.json"),authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json"),store=createTemplateStore({candidates}),authStore=createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint});
  stage="preflight";const credentialStatus=await getEasyPatCredentialStatus();if(!credentialStatus.available||!credentialStatus.usernamePresent||!credentialStatus.passwordPresent)throw new Error("PREFLIGHT_REJECTED");
  const [countEnvelope,searchEnvelope,mainEnvelope,relatedEnvelope]=await Promise.all([countDefinition.templateId,searchDefinition.templateId,"matter-detail.main-record.v1",relatedDefinition.templateId].map(id=>store.load(id)));await authStore.load();
  const bindingEvidence=inspectRelatedCountsBinding({mainEnvelope,relatedEnvelope});if(!bindingEvidence.matterBindingObserved||JSON.stringify(bindingEvidence.matterIdentityPredicateColumns)!==JSON.stringify(relatedDefinition.parameterization.predicateColumns)||bindingEvidence.matterIdentityPredicateOccurrences.some(item=>item.occurrenceCount!==relatedDefinition.parameterization.expectedOccurrenceCounts[item.column]))throw new Error("PREFLIGHT_REJECTED");
  await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error("PREFLIGHT_REJECTED");
  const attemptKey=createHash("sha256").update(matterReference,"utf8").digest("hex");attempt=path.join(root,`live-generic-related-counts-${attemptKey}.v2.json`);startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:2,status:"started",operation:"generic-related-counts",matterReference,startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const adapter=createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:authStore,expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),transport=createHttpsTransport();let businessReadRequestCount=0;
  const execute=async({operation,envelope})=>{validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);let cookie,body,response;try{cookie=await session.getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();businessReadRequestCount++;response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("READ_REJECTED");const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}finally{cookie=null;body=null;response=null;}};
  stage="count-search";const countEnvelopeBound=bindMatterReferenceSearchTemplate({envelope:countEnvelope,definition:countDefinition,matterReference}),countResult=await execute({operation:"search-matter",envelope:countEnvelopeBound});
  if(countResult.columns.length!==1||countResult.columns[0]!==countDefinition.responseCountColumn||countResult.rows.length!==1)throw new Error("SEARCH_REJECTED");
  const candidateCount=readMatterSearchCandidateCount({result:countResult,definition:countDefinition});
  const searchEnvelopeBound=bindMatterReferenceSearchTemplate({envelope:searchEnvelope,definition:searchDefinition,matterReference}),searchResult=await execute({operation:"search-matter",envelope:searchEnvelopeBound});
  if(searchResult.rows.length!==candidateCount)throw new Error("SEARCH_REJECTED");
  const context=createMatterIdentityContext({matterReference,searchResult,definition:searchDefinition});
  stage="related-counts-read";const relatedBound=bindMatterIdentityDetailTemplate({envelope:relatedEnvelope,definition:relatedDefinition,context}),result=await execute({operation:"get-matter-detail",envelope:relatedBound});
  if(result.columns.length!==EXPECTED.length||EXPECTED.some((column,index)=>result.columns[index]!==column)||result.rows.length!==1||EXPECTED.some(column=>!/^(?:0|[1-9]\d*)$/.test(result.rows[0][column]??""))||businessReadRequestCount!==3)throw new Error("RESULT_REJECTED");
  const attachmentCount=Number(result.rows[0]["첨부수"]),claimCount=Number(result.rows[0]["청구수"]);await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"generic-related-counts",matterReference,startedAt,completedAt:new Date().toISOString(),businessReadRequestCount,attachmentCount,claimCount}),{mode:0o600});
  console.log(JSON.stringify({status:"live-generic-related-counts-validated",matterReference,businessReadRequestCount,attachmentCount,claimCount,responseColumnCount:EXPECTED.length,matterIdentityBindingVerified:true,rawRowsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false,mcpExposureEnabled:false}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"generic-related-counts",matterReference,startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}console.error(JSON.stringify({status:"live-generic-related-counts-validation-failed",failureStage:stage,rawValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));process.exitCode=1;}
