import {readFileSync} from "node:fs";
import {validateProtocolIntent} from "./core.mjs";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {diagnoseVerifiedDocumentListEvidence,projectVerifiedDocumentList} from "./protocol/document-list.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./protocol/https-transport.mjs";
import {deriveMatterAttachmentListTemplate,selectNoticeAttachmentCandidates,verifyMatterAttachmentList} from "./protocol/matter-attachment-source.mjs";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";
import {bindMatterIdentityDetailTemplate,bindMatterReferenceSearchTemplate,createMatterIdentityContext,readMatterSearchCandidateCount} from "./protocol/parameterized-read-template.mjs";
import {createReadOnlyBatch} from "./protocol/read-only-guard.mjs";
import {compilePredicateResponseIdentity,verifyPredicateResponseIdentity} from "./protocol/response-identity.mjs";
import {parseResultset} from "./protocol/resultset.mjs";
import {createVerifiedAuthenticationAdapter} from "./security/authentication-adapter.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {createSessionProvider} from "./security/session-provider.mjs";
import {createTemplateStore} from "./security/template-store.mjs";
import {getEasyPatCredentialStatus} from "./security/windows-secrets.mjs";

const readJson=relative=>JSON.parse(readFileSync(new URL(relative,import.meta.url),"utf8"));
const RELATED_COLUMNS=["진행수","연차수","신규성수","연구과제수","우선권수","첨부수","업무관리수","청구수","메모수","메일발송수"];

function input(argv){
  if(argv.length!==4||argv[0]!=="--matter-reference"||argv[2]!=="--progress-document")throw new Error("INPUT_REJECTED");
  const matterReference=normalizeExactMatterReference(argv[1]),progressDocument=argv[3];
  if(typeof progressDocument!=="string"||!progressDocument.length||progressDocument!==progressDocument.trim()||progressDocument.length>512)throw new Error("INPUT_REJECTED");
  return{matterReference,progressDocument};
}
function exactSchema(result,expected){return Array.isArray(result?.columns)&&result.columns.length===expected.length&&expected.every((column,index)=>column===result.columns[index]);}

let stage="input",businessReadRequestCount=0,valueDiagnostics=null;
try{
  const {matterReference,progressDocument}=input(process.argv.slice(2));
  const registry=readJson("../config/generic-read-template-registry.json"),policy=readJson("../config/safety-policy.json"),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json");
  if(!policy.genericDownloadConstraints?.authorizedValidationMatterReferences?.includes(matterReference)||policy.mutationOperationsEnabled!==false||policy.arbitrarySqlEnabled!==false)throw new Error("PREFLIGHT_REJECTED");
  const definition=id=>structuredClone(registry.templates.find(template=>template.templateId===id));
  const count=definition("matter-search.exact-count.v1"),search=definition("matter-search.exact-result.v1"),progress=definition("matter-detail.progress-records.v1"),document=definition("matter-detail.documents.matter-candidate.v1"),relatedCandidate=fingerprints.candidates.find(item=>item.templateId==="matter-detail.related-counts.v1");
  if(!count||!search||!progress||!document||!relatedCandidate||document.expectedResponseColumns?.length!==27)throw new Error("PREFLIGHT_REJECTED");
  const related={templateId:relatedCandidate.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:relatedCandidate.fingerprint,parameterization:{mode:"multi-scalar-equality",source:"verified-search-identity",predicateColumns:["idx_parent","GRP_KEY","idx_data"],expectedOccurrenceCounts:{idx_parent:11,GRP_KEY:1,idx_data:1},sourceTemplateId:search.templateId,sourceColumn:search.responseIdentityColumn}};
  const authenticationTemplate=readJson("../config/authentication-template.json"),authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json"),store=createTemplateStore({candidates:fingerprints.candidates}),authStore=createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint});
  stage="preflight";const credentialStatus=await getEasyPatCredentialStatus();if(!credentialStatus.available||!credentialStatus.usernamePresent||!credentialStatus.passwordPresent)throw new Error("PREFLIGHT_REJECTED");
  const [countBase,searchBase,progressBase,relatedBase]=await Promise.all([count.templateId,search.templateId,progress.templateId,related.templateId].map(id=>store.load(id)));await authStore.load();
  const broad=deriveMatterAttachmentListTemplate({relatedEnvelope:relatedBase,relatedCandidate,expectedResponseColumns:document.expectedResponseColumns});
  const adapter=createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:authStore,expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),transport=createHttpsTransport();
  const execute=async(operation,envelope)=>{
    validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);let cookie,body,response;
    try{cookie=await session.getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();businessReadRequestCount++;response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("READ_REJECTED");const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}
    finally{cookie=null;body=null;response=null;}
  };
  stage="search-count";const countEnvelope=bindMatterReferenceSearchTemplate({envelope:countBase,definition:count,matterReference}),countResult=await execute("search-matter",countEnvelope),candidateCount=readMatterSearchCandidateCount({result:countResult,definition:count});
  stage="search-rows";const searchEnvelope=bindMatterReferenceSearchTemplate({envelope:searchBase,definition:search,matterReference}),searchResult=await execute("search-matter",searchEnvelope);if(searchResult.rows.length!==candidateCount)throw new Error("SEARCH_REJECTED");const context=createMatterIdentityContext({matterReference,searchResult,definition:search});
  stage="progress";const progressEnvelope=bindMatterIdentityDetailTemplate({envelope:progressBase,definition:progress,context}),progressBinding=compilePredicateResponseIdentity(progressEnvelope.statements[0],progress.responseVerification),progressResult=await execute("list-progress",progressEnvelope);
  if(!exactSchema(progressResult,progress.expectedResponseColumns)||progressResult.rows.length<1||progressResult.rows.length>500)throw new Error("PROGRESS_REJECTED");verifyPredicateResponseIdentity(progressResult,progressBinding);
  const progressMatches=progressResult.rows.filter(row=>row?.rec_doc===progressDocument);if(progressMatches.length!==1)throw new Error("PROGRESS_REJECTED");const selectedProgress=progressMatches[0];
  stage="attachment-count";const relatedEnvelope=bindMatterIdentityDetailTemplate({envelope:relatedBase,definition:related,context}),relatedResult=await execute("get-matter-detail",relatedEnvelope);
  if(!exactSchema(relatedResult,RELATED_COLUMNS)||relatedResult.rows.length!==1||RELATED_COLUMNS.some(column=>!/^(?:0|[1-9]\d*)$/.test(relatedResult.rows[0]?.[column]??"")))throw new Error("ATTACHMENT_COUNT_REJECTED");const attachmentCount=Number(relatedResult.rows[0]["첨부수"]);if(attachmentCount>500)throw new Error("ATTACHMENT_COUNT_REJECTED");
  stage="attachment-list";const attachmentEnvelope=bindMatterIdentityDetailTemplate({envelope:broad.envelope,definition:broad.definition,context}),attachmentResult=await execute("list-documents",attachmentEnvelope);
  verifyMatterAttachmentList({result:attachmentResult,compiledEnvelope:attachmentEnvelope,definition:broad.definition,divisionLike:broad.divisionLike,expectedCount:attachmentCount});
  valueDiagnostics=diagnoseVerifiedDocumentListEvidence({...attachmentResult,matterReference},{matterReference,templateId:broad.definition.templateId});
  const documents=projectVerifiedDocumentList({...attachmentResult,matterReference},{matterReference,responseBindingVerified:true,templateId:broad.definition.templateId});
  const candidates=selectNoticeAttachmentCandidates({items:documents.items,matterReference,progressDocument});
  console.log(JSON.stringify({status:"live-oa-attachment-source-validated",matterReference,progressDocument,noticeDate:selectedProgress.d_noti||null,dueDate:selectedProgress.d_due||null,sequence:selectedProgress.no_rec||null,businessReadRequestCount,aggregateAttachmentCount:attachmentCount,verifiedAttachmentCount:documents.count,candidateAttachmentCount:candidates.length,candidates,exactMatterCandidateCount:candidateCount,rawRowsReturned:false,serverUploadPathsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false,mcpExposureEnabled:false}));
}catch(error){
  console.error(JSON.stringify({status:"live-oa-attachment-source-validation-failed",failureStage:stage,failureCode:/^[A-Z0-9_]+$/.test(error?.message??"")?error.message:"OA_ATTACHMENT_SOURCE_REJECTED",businessReadRequestCount,valueDiagnostics,rawValuesReturned:false,serverUploadPathsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));process.exitCode=1;
}
