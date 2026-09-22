import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createReadOnlyBatch} from "./protocol/read-only-guard.mjs";
import {extractCapturedEnvelope} from "./protocol/fiddler-capture.mjs";
import {collectLiteralEqualities} from "./protocol/matter-linkage.mjs";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";
import {projectVerifiedDocumentList,resolveVerifiedDocumentDownload} from "./protocol/document-list.mjs";
import {compileResponsePredicateSet,verifyResponsePredicateSet} from "./protocol/response-predicate-set.mjs";
import {parseResultset} from "./protocol/resultset.mjs";

const SOURCE_ID="77777777-7777-7777-7777-777777777777";
const FIDDLER_ORIGIN="http://localhost:18929";
const EASYPAT_ENDPOINT="https://mssql2.easypnp.co.kr:8443/servlet/Jbori";
const MAX_BODY_BYTES=2*1024*1024;
const LABEL="위임계약서 (x)";

function parseArgs(argv){
  if((argv.length!==6&&argv.length!==8)||argv[0]!=="--matter-reference"||argv[2]!=="--progress-session"||argv[4]!=="--document-session"||
     (argv.length===8&&argv[6]!=="--pdf-session"))throw new Error("INPUT_REJECTED");
  const matterReference=normalizeExactMatterReference(argv[1]);
  const progressSession=Number(argv[3]),documentSession=Number(argv[5]);
  const pdfSession=argv.length===8?Number(argv[7]):null;
  if(!Number.isSafeInteger(progressSession)||progressSession<1||!Number.isSafeInteger(documentSession)||documentSession<1||progressSession===documentSession||
     (pdfSession!==null&&(!Number.isSafeInteger(pdfSession)||pdfSession<1||pdfSession===progressSession||pdfSession===documentSession)))throw new Error("INPUT_REJECTED");
  return{matterReference,progressSession,documentSession,pdfSession};
}

async function fiddlerPayload(sessionId,part){
  const url=`${FIDDLER_ORIGIN}/api/Sessions/${SOURCE_ID}/${sessionId}/${part}`;
  const response=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw new Error("FIDDLER_READ_REJECTED");
  const raw=await response.text();
  if(Buffer.byteLength(raw,"utf8")>MAX_BODY_BYTES)throw new Error("FIDDLER_READ_REJECTED");
  let payload;
  try{payload=JSON.parse(raw);}catch{throw new Error("FIDDLER_READ_REJECTED");}
  if(!payload||typeof payload.httpMessage!=="string"||Buffer.byteLength(payload.httpMessage,"utf8")>MAX_BODY_BYTES)throw new Error("FIDDLER_READ_REJECTED");
  return payload;
}

async function fiddlerBody(sessionId,side){
  return (await fiddlerPayload(sessionId,`${side}/Body`)).httpMessage;
}

function capturedEnvelope(sessionId,requestBody){
  return extractCapturedEnvelope({
    id:sessionId,url:EASYPAT_ENDPOINT,method:"POST",statusCode:200,
    requestBody:{mimeType:"application/x-www-form-urlencoded",content:requestBody,isBase64:false},
  });
}

function exactSchema(result,expected){
  return result.columns.length===expected.length&&expected.every((column,index)=>column===result.columns[index]);
}

function uniquePredicate(statement,column){
  const matches=collectLiteralEqualities(statement).filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(matches.length!==1||typeof matches[0].literal!=="string"||!matches[0].literal.length)throw new Error("CAPTURE_BINDING_REJECTED");
  return matches[0].literal;
}

function parsedHeaders(text){
  const lines=text.split(/\r?\n/),firstLine=lines.shift();
  if(typeof firstLine!=="string"||!firstLine.length)throw new Error("PDF_HEADERS_REJECTED");
  const headers=new Map();
  for(const line of lines){
    if(!line)continue;
    const pos=line.indexOf(":");
    if(pos<1)throw new Error("PDF_HEADERS_REJECTED");
    const name=line.slice(0,pos).trim().toLowerCase(),value=line.slice(pos+1).trim();
    if(!name||headers.has(name))throw new Error("PDF_HEADERS_REJECTED");
    headers.set(name,value);
  }
  return{firstLine,headers};
}

function pdfBytes(payload){
  const direct=Buffer.from(payload.httpMessage,"latin1");
  if(direct.subarray(0,5).toString("ascii")==="%PDF-")return direct;
  if(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.httpMessage)){
    const decoded=Buffer.from(payload.httpMessage,"base64");
    if(decoded.subarray(0,5).toString("ascii")==="%PDF-")return decoded;
  }
  throw new Error("PDF_BODY_REJECTED");
}

let stage="input",pdfDiagnostic;
try{
  const {matterReference,progressSession,documentSession,pdfSession}=parseArgs(process.argv.slice(2));
  const registry=JSON.parse(readFileSync(new URL("../config/read-template-registry.json",import.meta.url),"utf8"));
  const progressDefinition=registry.templates.find(item=>item.templateId==="matter-detail.progress-records.v1");
  const documentDefinition=registry.templates.find(item=>item.templateId==="matter-detail.documents.v1");
  if(!progressDefinition||!documentDefinition)throw new Error("PREFLIGHT_REJECTED");

  stage="read-local-capture";
  const [progressRequest,progressResponse,documentRequest,documentResponse]=await Promise.all([
    fiddlerBody(progressSession,"Request"),fiddlerBody(progressSession,"Response"),
    fiddlerBody(documentSession,"Request"),fiddlerBody(documentSession,"Response"),
  ]);
  stage="parse-capture";
  const progressEnvelope=capturedEnvelope(progressSession,progressRequest),documentEnvelope=capturedEnvelope(documentSession,documentRequest);
  createReadOnlyBatch([{templateId:"capture.progress-document-intermediate.v1",...progressEnvelope},{templateId:"capture.progress-document-list.v1",...documentEnvelope}]);
  if(progressEnvelope.command!=="SELECT"||progressEnvelope.statements.length!==1||documentEnvelope.command!=="SELECT"||documentEnvelope.statements.length!==1)throw new Error("CAPTURE_SHAPE_REJECTED");
  const progressResult=parseResultset(progressResponse),documentResult=parseResultset(documentResponse);
  if(!exactSchema(progressResult,progressDefinition.expectedResponseColumns)||progressResult.rows.length!==1||
     !exactSchema(documentResult,documentDefinition.expectedResponseColumns)||documentResult.rows.length<1||documentResult.rows.length>500)throw new Error("CAPTURE_SCHEMA_REJECTED");

  stage="verify-chain";
  const progressIdentity=uniquePredicate(progressEnvelope.statements[0],"idx");
  const progressRow=progressResult.rows[0];
  if(progressRow.idx!==progressIdentity||progressRow.rec_doc!==LABEL||typeof progressRow.idx_parent!=="string"||!progressRow.idx_parent.length)throw new Error("CAPTURE_PROGRESS_BINDING_REJECTED");
  const documentGroup=uniquePredicate(documentEnvelope.statements[0],"GRP_KEY");
  if(documentGroup!==progressRow.idx_parent)throw new Error("CAPTURE_BRIDGE_REJECTED");
  const predicateBinding=compileResponsePredicateSet(documentEnvelope.statements[0],documentDefinition.responsePredicateSetVerification);
  const predicateVerification=verifyResponsePredicateSet(documentResult,predicateBinding);

  stage="safe-projection";
  const documents=projectVerifiedDocumentList({...documentResult,matterReference,templateId:"capture.progress-document-list.v1"},{matterReference,responseBindingVerified:true,templateId:"capture.progress-document-list.v1"});
  let pdfDownload=null;
  if(pdfSession!==null){
    if(documents.count!==1)throw new Error("PDF_SELECTION_REJECTED");
    const selection=resolveVerifiedDocumentDownload({...documentResult,matterReference,templateId:"capture.progress-document-list.v1"},{matterReference,position:1,expectedFileName:documents.items[0].fileName,responseBindingVerified:true,templateId:"capture.progress-document-list.v1"});
    stage="verify-pdf-download";
    const [requestHeadersPayload,responseHeadersPayload,responseBodyPayload]=await Promise.all([
      fiddlerPayload(pdfSession,"Request/Headers"),fiddlerPayload(pdfSession,"Response/Headers"),fiddlerPayload(pdfSession,"Response/Body"),
    ]);
    stage="parse-pdf-headers";
    const requestHeaders=parsedHeaders(requestHeadersPayload.httpMessage),responseHeaders=parsedHeaders(responseHeadersPayload.httpMessage);
    const requestMatch=/^GET\s+(\S+)\s+HTTP\/1\.[01]$/.exec(requestHeaders.firstLine);
    pdfDiagnostic={requestLineRecognized:!!requestMatch,hostRecognized:/^mssql2\.easypnp\.co\.kr(?::8443)?$/i.test(requestHeaders.headers.get("host")??""),responseStatus200:/^HTTP\/1\.[01]\s+200(?:\s|$)/.test(responseHeaders.firstLine),contentTypePdf:/application\/pdf/i.test(responseHeaders.headers.get("content-type")??""),rawValuesReturned:false};
    if(!pdfDiagnostic.requestLineRecognized||!pdfDiagnostic.hostRecognized)throw new Error("PDF_REQUEST_REJECTED");
    let requestUrl,requestPath;
    try{requestUrl=requestMatch[1].startsWith("http")?new URL(requestMatch[1]):new URL(requestMatch[1],EASYPAT_ENDPOINT);requestPath=decodeURIComponent(requestUrl.pathname);}catch{throw new Error("PDF_REQUEST_REJECTED");}
    pdfDiagnostic.requestPathExactMatched=requestPath===`/${selection.uploadPath}`;
    pdfDiagnostic.requestPathSuffixMatched=requestPath.endsWith(`/${selection.uploadPath}`);
    pdfDiagnostic.requestQueryParameterCount=[...requestUrl.searchParams.keys()].length;
    pdfDiagnostic.requestPathMatched=pdfDiagnostic.requestPathExactMatched||pdfDiagnostic.requestPathSuffixMatched;
    if(!pdfDiagnostic.requestPathMatched)throw new Error("PDF_REQUEST_BINDING_REJECTED");
    if(!pdfDiagnostic.responseStatus200||!pdfDiagnostic.contentTypePdf)throw new Error("PDF_RESPONSE_REJECTED");
    stage="parse-pdf-body";
    const bytes=pdfBytes(responseBodyPayload),contentLength=responseHeaders.headers.get("content-length");
    pdfDiagnostic.bodyMagicVerified=true;pdfDiagnostic.fiddlerBodyEncodedFlag=responseBodyPayload.isEncoded===true;pdfDiagnostic.fiddlerBodyTruncatedFlag=responseBodyPayload.isTruncated===true;
    pdfDiagnostic.bodySizeBytes=bytes.length;pdfDiagnostic.expectedFileSizeBytes=selection.fileSizeBytes;
    pdfDiagnostic.headerContentLength=/^\d+$/.test(contentLength??"")?Number(contentLength):null;
    pdfDiagnostic.bodySizeMatched=bytes.length===selection.fileSizeBytes;pdfDiagnostic.headerSizeMatched=pdfDiagnostic.headerContentLength===selection.fileSizeBytes;
    pdfDiagnostic.fiddlerTextSerializationChangedBinaryLength=!pdfDiagnostic.bodySizeMatched;
    if(pdfDiagnostic.fiddlerBodyTruncatedFlag||!pdfDiagnostic.headerSizeMatched)throw new Error("PDF_SIZE_REJECTED");
    pdfDownload={sourceSession:pdfSession,statusCode:200,contentType:"application/pdf",fileName:selection.fileName,fileSizeBytes:selection.fileSizeBytes,requestBoundToSelectedDocument:true,pdfMagicVerified:true,contentLengthVerified:true,captureBodyHashComputed:pdfDiagnostic.bodySizeMatched,sha256:pdfDiagnostic.bodySizeMatched?createHash("sha256").update(bytes).digest("hex"):null};
  }
  console.log(JSON.stringify({
    status:"fiddler-progress-document-chain-validated",matterReference,progressDocument:LABEL,
    sourceSessions:{progress:progressSession,documents:documentSession},
    progressRowCount:progressResult.rows.length,documentItemCount:documents.count,documents,pdfDownload,
    progressRequestIdentityMatched:true,documentGroupBridgeMatched:true,
    documentPredicateColumnsVerified:predicateVerification.responseColumns.length,
    rawSqlReturned:false,rawRowsReturned:false,internalIdentityReturned:false,serverUploadPathsReturned:false,
    serverRequestsPerformed:0,productionEnabled:false,mcpExposureEnabled:false,
  }));
}catch{
  console.error(JSON.stringify({status:"fiddler-progress-document-chain-rejected",failureStage:stage,pdfDiagnostic,rawSqlReturned:false,rawRowsReturned:false,internalIdentityReturned:false,serverUploadPathsReturned:false,serverRequestsPerformed:0,productionEnabled:false}));
  process.exitCode=1;
}
