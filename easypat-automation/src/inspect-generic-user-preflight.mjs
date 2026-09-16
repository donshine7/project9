import {readFileSync} from "node:fs";
import {createTemplateStore} from "./security/template-store.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {getEasyPatCredentialStatus} from "./security/windows-secrets.mjs";
import {bindMatterReferenceSearchTemplate,createMatterIdentityContext,bindMatterIdentityDetailTemplate} from "./protocol/parameterized-read-template.mjs";
import {compilePredicateResponseIdentity} from "./protocol/response-identity.mjs";
import {createEasyPatRuntime} from "./runtime.mjs";

const read=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
let stage="configuration";
const matterReference="PT261130";
const result={productionConfigurationReady:false,credentialsReady:false,authenticationTemplateReady:false,countTemplateReady:false,resultTemplateReady:false,detailTemplateReady:false,progressTemplateReady:false,documentTemplateReady:false,searchBindingsReady:false,detailBindingReady:false,progressBindingReady:false,documentSourceReady:false,documentGeneralizationBlocked:true,runtimeCandidateReady:false,mcpExposureEnabled:false,rawValuesReturned:false,serverRequestsPerformed:0};
try{
  const generic=read("../config/generic-read-template-registry.json"),policy=read("../config/safety-policy.json"),candidates=read("../config/protocol-observations/local-read-fingerprints.json").candidates,auth=read("../config/authentication-template.json");
  const definition=id=>structuredClone(generic.templates.find(item=>item.templateId===id));
  const countDefinition=definition("matter-search.exact-count.v1"),searchDefinition=definition("matter-search.exact-result.v1"),detailDefinition=definition("matter-detail.main-record.v1"),progressDefinition=definition("matter-detail.progress-records.v1");
  if(!countDefinition||!searchDefinition||!detailDefinition||!progressDefinition||generic.productionEnabled!==true||
     generic.completedDistinctNonBaselineMatterValidations!==generic.requiredDistinctNonBaselineMatterValidations||
     generic.completedDistinctNonBaselineMatterValidations!==2||
     !generic.validatedNonBaselineMatterReferences?.includes("PT261129")||!generic.validatedNonBaselineMatterReferences?.includes("PT261130")||
     [countDefinition,searchDefinition,detailDefinition].some(definition=>definition.productionEnabled!==true)||progressDefinition.productionEnabled!==false||
     policy.genericMatterSummaryConstraints?.enabled!==true||policy.genericMatterSummaryConstraints?.mcpExposureEnabled!==false||
     policy.genericDocumentConstraints?.enabled!==false||policy.genericDocumentConstraints?.mcpExposureEnabled!==false||
     policy.mutationOperationsEnabled!==false||policy.arbitrarySqlEnabled!==false)throw new Error();
  result.productionConfigurationReady=true;
  stage="credentials";const status=await getEasyPatCredentialStatus();if(!status.available||!status.usernamePresent||!status.passwordPresent)throw new Error();result.credentialsReady=true;
  stage="authentication-template";await createAuthenticationTemplateStore({expectedFingerprint:auth.fingerprint}).load();result.authenticationTemplateReady=true;
  const store=createTemplateStore({candidates});
  stage="count-template";const countEnvelope=await store.load(countDefinition.templateId);result.countTemplateReady=true;
  stage="result-template";const searchEnvelope=await store.load(searchDefinition.templateId);result.resultTemplateReady=true;
  stage="detail-template";const detailEnvelope=await store.load(detailDefinition.templateId);result.detailTemplateReady=true;
  stage="progress-template";const progressEnvelope=await store.load(progressDefinition.templateId);result.progressTemplateReady=true;
  stage="document-template";await store.load("matter-detail.documents.v1");result.documentTemplateReady=true;
  stage="search-binding";bindMatterReferenceSearchTemplate({envelope:countEnvelope,definition:countDefinition,matterReference});bindMatterReferenceSearchTemplate({envelope:searchEnvelope,definition:searchDefinition,matterReference});result.searchBindingsReady=true;
  stage="detail-binding";
  const row=Object.fromEntries(searchDefinition.expectedResponseColumns.map(column=>[column,column==="idx"?"999999":column==="ourref"?matterReference:""]));
  const context=createMatterIdentityContext({matterReference,definition:searchDefinition,searchResult:{templateId:searchDefinition.templateId,columns:searchDefinition.expectedResponseColumns,rows:[row]}});
  const compiled=bindMatterIdentityDetailTemplate({envelope:detailEnvelope,definition:detailDefinition,context});
  compilePredicateResponseIdentity(compiled.statements[0],detailDefinition.responseVerification);result.detailBindingReady=true;
  stage="progress-binding";const compiledProgress=bindMatterIdentityDetailTemplate({envelope:progressEnvelope,definition:progressDefinition,context});compilePredicateResponseIdentity(compiledProgress.statements[0],progressDefinition.responseVerification);result.progressBindingReady=true;
  stage="runtime-construction";const runtime=createEasyPatRuntime();const runtimeStatus=runtime.status();if(runtimeStatus.genericMatterSummaryCandidateReady!==true||runtimeStatus.genericMatterSummaryEnabled!==false||runtimeStatus.session.attempted!==false)throw new Error();result.runtimeCandidateReady=true;
  console.log(JSON.stringify({status:"generic-user-preflight-ready-document-source-pending",...result}));
}catch{console.error(JSON.stringify({status:"generic-user-preflight-failed",failureStage:stage,...result}));process.exitCode=1;}
