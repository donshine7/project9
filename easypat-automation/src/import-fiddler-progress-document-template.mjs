import {readFileSync} from "node:fs";
import {lstat,mkdir,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createReadOnlyBatch} from "./protocol/read-only-guard.mjs";
import {extractCapturedEnvelope} from "./protocol/fiddler-capture.mjs";
import {collectLiteralEqualities} from "./protocol/matter-linkage.mjs";
import {compileResponsePredicateSet,verifyResponsePredicateSet} from "./protocol/response-predicate-set.mjs";
import {parseResultset} from "./protocol/resultset.mjs";
import {fingerprintEnvelope} from "./protocol/template-fingerprint.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const SOURCE_ID="77777777-7777-7777-7777-777777777777";
const FIDDLER_ORIGIN="http://localhost:18929";
const EASYPAT_ENDPOINT="https://mssql2.easypnp.co.kr:8443/servlet/Jbori";
const TEMPLATE_ID="matter-detail.progress-documents.v1";
const LABEL="위임계약서 (x)";
const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const metadataPath=path.join(root,"progress-document-list-request.v1.json");

function parseArgs(argv){
  if(argv.length!==4||argv[0]!=="--progress-session"||argv[2]!=="--document-session")throw new Error("INPUT_REJECTED");
  const progressSession=Number(argv[1]),documentSession=Number(argv[3]);
  if(!Number.isSafeInteger(progressSession)||progressSession<1||!Number.isSafeInteger(documentSession)||documentSession<1||progressSession===documentSession)throw new Error("INPUT_REJECTED");
  return{progressSession,documentSession};
}

async function body(sessionId,side){
  const response=await fetch(`${FIDDLER_ORIGIN}/api/Sessions/${SOURCE_ID}/${sessionId}/${side}/Body`,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw new Error("FIDDLER_READ_REJECTED");
  const text=await response.text();
  if(Buffer.byteLength(text,"utf8")>2*1024*1024)throw new Error("FIDDLER_READ_REJECTED");
  let payload;try{payload=JSON.parse(text);}catch{throw new Error("FIDDLER_READ_REJECTED");}
  if(!payload||typeof payload.httpMessage!=="string"||Buffer.byteLength(payload.httpMessage,"utf8")>1024*1024)throw new Error("FIDDLER_READ_REJECTED");
  return payload.httpMessage;
}

function envelope(sessionId,requestBody,templateId){
  const captured=extractCapturedEnvelope({id:sessionId,url:EASYPAT_ENDPOINT,method:"POST",statusCode:200,requestBody:{mimeType:"application/x-www-form-urlencoded",content:requestBody,isBase64:false}});
  return{templateId,...captured};
}

function predicate(statement,column){
  const matches=collectLiteralEqualities(statement).filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(matches.length!==1||typeof matches[0].literal!=="string"||!matches[0].literal.length)throw new Error("BINDING_REJECTED");
  return matches[0].literal;
}

function exactSchema(result,expected){return result.columns.length===expected.length&&expected.every((column,index)=>column===result.columns[index]);}

let stage="input";
try{
  const {progressSession,documentSession}=parseArgs(process.argv.slice(2));
  const registry=JSON.parse(readFileSync(new URL("../config/read-template-registry.json",import.meta.url),"utf8"));
  const progressDefinition=registry.templates.find(item=>item.templateId==="matter-detail.progress-records.v1"),documentDefinition=registry.templates.find(item=>item.templateId==="matter-detail.documents.v1");
  if(!progressDefinition||!documentDefinition)throw new Error("PREFLIGHT_REJECTED");
  stage="read-local-capture";
  const [progressRequest,progressResponse,documentRequest,documentResponse]=await Promise.all([body(progressSession,"Request"),body(progressSession,"Response"),body(documentSession,"Request"),body(documentSession,"Response")]);
  stage="validate-capture";
  const progressEnvelope=envelope(progressSession,progressRequest,"capture.progress-document-intermediate.v1"),documentEnvelope=envelope(documentSession,documentRequest,TEMPLATE_ID);
  createReadOnlyBatch([progressEnvelope,documentEnvelope]);
  if(progressEnvelope.command!=="SELECT"||progressEnvelope.statements.length!==1||documentEnvelope.command!=="SELECT"||documentEnvelope.statements.length!==1)throw new Error("SHAPE_REJECTED");
  const progressResult=parseResultset(progressResponse),documentResult=parseResultset(documentResponse);
  if(!exactSchema(progressResult,progressDefinition.expectedResponseColumns)||progressResult.rows.length!==1||progressResult.rows[0].rec_doc!==LABEL||
     !exactSchema(documentResult,documentDefinition.expectedResponseColumns)||documentResult.rows.length<1||documentResult.rows.length>500)throw new Error("RESPONSE_REJECTED");
  if(progressResult.rows[0].idx!==predicate(progressEnvelope.statements[0],"idx")||progressResult.rows[0].idx_parent!==predicate(documentEnvelope.statements[0],"GRP_KEY"))throw new Error("BRIDGE_REJECTED");
  const verification=verifyResponsePredicateSet(documentResult,compileResponsePredicateSet(documentEnvelope.statements[0],documentDefinition.responsePredicateSetVerification));
  const fingerprint=fingerprintEnvelope(documentEnvelope),candidate={sessionId:documentSession,templateId:TEMPLATE_ID,command:"SELECT",statementCount:1,fingerprint,productionEnabled:false};
  stage="store-encrypted-template";
  const store=createTemplateStore({candidates:[candidate]});let alreadyStored=false;
  try{await store.load(TEMPLATE_ID);alreadyStored=true;}catch{await store.save(TEMPLATE_ID,documentEnvelope);}
  const roundTrip=await store.load(TEMPLATE_ID);if(fingerprintEnvelope(roundTrip)!==fingerprint)throw new Error("ROUND_TRIP_REJECTED");
  await mkdir(root,{recursive:true});if((await lstat(root)).isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error("STORE_PATH_REJECTED");
  const metadata={schemaVersion:1,status:"captured",sourceSessionId:documentSession,bridgeSessionId:progressSession,templateId:TEMPLATE_ID,command:"SELECT",statementCount:1,fingerprint,
    progressDocument:LABEL,responseColumns:[...documentResult.columns],responsePredicateSetVerification:structuredClone(documentDefinition.responsePredicateSetVerification),
    documentRowCountObserved:documentResult.rows.length,documentPredicateColumnsVerified:verification.responseColumns.length,plaintextStored:false,productionEnabled:false};
  try{await writeFile(metadataPath,JSON.stringify(metadata),{flag:"wx",mode:0o600});}catch(error){if(error?.code!=="EEXIST")throw error;const existing=JSON.parse(await readFile(metadataPath,"utf8"));if(existing.fingerprint!==fingerprint||existing.templateId!==TEMPLATE_ID)throw new Error("METADATA_MISMATCH");}
  console.log(JSON.stringify({status:"progress-document-template-imported",templateId:TEMPLATE_ID,fingerprint,sourceSessionId:documentSession,bridgeSessionId:progressSession,documentRowCountObserved:documentResult.rows.length,documentPredicateColumnsVerified:verification.responseColumns.length,encryptedTemplateStored:true,alreadyStored,roundTripVerified:true,protection:"Windows-DPAPI-CurrentUser",plaintextStored:false,rawSqlReturned:false,rawRowsReturned:false,internalIdentityReturned:false,serverRequestsPerformed:0,productionEnabled:false}));
}catch{
  console.error(JSON.stringify({status:"progress-document-template-import-failed",failureStage:stage,plaintextStored:false,rawSqlReturned:false,rawRowsReturned:false,internalIdentityReturned:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;
}
