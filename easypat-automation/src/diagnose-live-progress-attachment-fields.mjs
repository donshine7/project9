import {readFileSync} from "node:fs";
import {validateProtocolIntent} from "./core.mjs";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./protocol/https-transport.mjs";
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
function exactSchema(result,expected){return Array.isArray(result?.columns)&&result.columns.length===expected.length&&expected.every((column,index)=>column===result.columns[index]);}
function input(argv){
  if(argv.length!==4||argv[0]!=="--matter-reference"||argv[2]!=="--progress-document")throw new Error();
  const matterReference=normalizeExactMatterReference(argv[1]),progressDocument=argv[3];
  if(typeof progressDocument!=="string"||!progressDocument.length||progressDocument!==progressDocument.trim()||progressDocument.length>512)throw new Error();
  return{matterReference,progressDocument};
}
function shape(column,value){
  const text=String(value),lengthBucket=text.length<=4?"1-4":text.length<=16?"5-16":text.length<=64?"17-64":"65+";
  return{column,valueType:typeof value,digitsOnly:/^\d+$/.test(text),lengthBucket};
}

let stage="input",businessReadRequestCount=0,observedExactCount=null;
try{
  const {matterReference,progressDocument}=input(process.argv.slice(2)),registry=readJson("../config/generic-read-template-registry.json"),policy=readJson("../config/safety-policy.json");
  if(!policy.genericDownloadConstraints?.authorizedValidationMatterReferences?.includes(matterReference)||policy.mutationOperationsEnabled!==false||policy.arbitrarySqlEnabled!==false)throw new Error();
  const definition=id=>structuredClone(registry.templates.find(template=>template.templateId===id));
  const count=definition("matter-search.exact-count.v1"),search=definition("matter-search.exact-result.v1"),progress=definition("matter-detail.progress-records.v1");
  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates,store=createTemplateStore({candidates});
  const authenticationTemplate=readJson("../config/authentication-template.json"),authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json"),authStore=createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint});
  stage="preflight";const credentialStatus=await getEasyPatCredentialStatus();if(!credentialStatus.available||!credentialStatus.usernamePresent||!credentialStatus.passwordPresent)throw new Error();
  await Promise.all([count.templateId,search.templateId,progress.templateId].map(id=>store.load(id)));await authStore.load();
  const adapter=createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:authStore,expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()}),session=createSessionProvider({adapter}),transport=createHttpsTransport();
  const execute=async(operation,envelope)=>{validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);let cookie,body,response;try{cookie=await session.getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();businessReadRequestCount++;response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error();const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}finally{cookie=null;body=null;response=null;}};
  stage="read-count";const countEnvelope=bindMatterReferenceSearchTemplate({envelope:await store.load(count.templateId),definition:count,matterReference});const countResult=await execute("search-matter",countEnvelope);
  if(exactSchema(countResult,count.expectedResponseColumns)&&countResult.rows.length===1&&/^\d+$/.test(countResult.rows[0]?.[count.responseCountColumn]??""))observedExactCount=Number(countResult.rows[0][count.responseCountColumn]);
  if(!exactSchema(countResult,count.expectedResponseColumns)||countResult.rows.length!==1)throw new Error();
  const candidateCount=readMatterSearchCandidateCount({result:countResult,definition:count});
  stage="read-search";const searchEnvelope=bindMatterReferenceSearchTemplate({envelope:await store.load(search.templateId),definition:search,matterReference});const searchResult=await execute("search-matter",searchEnvelope);
  if(!exactSchema(searchResult,search.expectedResponseColumns)||searchResult.rows.length!==candidateCount)throw new Error();
  const context=createMatterIdentityContext({matterReference,searchResult,definition:search});
  stage="read-progress";const progressEnvelope=bindMatterIdentityDetailTemplate({envelope:await store.load(progress.templateId),definition:progress,context}),binding=compilePredicateResponseIdentity(progressEnvelope.statements[0],progress.responseVerification),progressResult=await execute("list-progress",progressEnvelope);
  if(!exactSchema(progressResult,progress.expectedResponseColumns)||progressResult.rows.length<1||progressResult.rows.length>500)throw new Error();verifyPredicateResponseIdentity(progressResult,binding);
  const matches=progressResult.rows.filter(row=>row?.rec_doc===progressDocument);if(matches.length!==1)throw new Error();
  const safeBusiness=new Set(["no_rec","d_rec","d_noti","rec_doc","rec_div","rec_memo","d_brief_due","d_opinion_due","d_proc","d_due","clerk","part","method"]),row=matches[0];
  const nonEmptyFields=progressResult.columns.filter(column=>row[column]!==null&&row[column]!=="").map(column=>shape(column,row[column]));
  console.log(JSON.stringify({status:"live-progress-attachment-fields-diagnosed",matterReference,progressDocument,businessReadRequestCount,nonEmptyFieldCount:nonEmptyFields.length,nonEmptyFields,hiddenNonEmptyColumns:nonEmptyFields.filter(item=>!safeBusiness.has(item.column)).map(item=>item.column),rawValuesReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));
}catch{
  console.error(JSON.stringify({status:"live-progress-attachment-fields-diagnostic-failed",failureStage:stage,businessReadRequestCount,observedExactCount,rawValuesReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled:false}));process.exitCode=1;
}
