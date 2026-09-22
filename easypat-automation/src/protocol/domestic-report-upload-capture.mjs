import {createHash} from "node:crypto";

const ENDPOINT="https://mssql2.easypnp.co.kr:8443/servlet/Jbori";
const UPLOAD_ENDPOINT="https://mssql2.easypnp.co.kr:8443/servlet/UploadExecute";
const CONNECTION="EASYPAT_S_SSPAT";
const UPLOAD_CONNECTION="EASYPAT_S_SSPAT_app_proc";
const MAX_CAPTURE_BYTES=2*1024*1024;
const TEMPLATE_BY_KIND=Object.freeze({
  "attach-insert":Object.freeze({templateId:"matter-progress.attach-insert.v1",command:"INSERT",statementCount:1}),
  "progress-insert-batch":Object.freeze({templateId:"matter-progress.insert-batch.v1",command:"OTHERS",statementCount:2}),
  "history-batch":Object.freeze({templateId:"matter-progress.history-batch.v1",command:"OTHERS",statementCount:4}),
  "progress-readback":Object.freeze({templateId:"matter-progress.readback.v1",command:"SELECT",statementCount:1}),
  "attachment-readback":Object.freeze({templateId:"matter-progress.attachment-readback.v1",command:"SELECT",statementCount:1}),
});

export class DomesticReportCaptureError extends Error{
  constructor(code){super(code);this.name="DomesticReportCaptureError";this.code=code;}
}

function reject(code){throw new DomesticReportCaptureError(code);}

function splitRawRequest(raw,expectedEndpoint){
  if(typeof raw!=="string"||!raw.length||Buffer.byteLength(raw,"utf8")>MAX_CAPTURE_BYTES||raw.includes("\0"))reject("UPLOAD_CAPTURE_INPUT_REJECTED");
  const crlfSeparator=raw.indexOf("\r\n\r\n"),lfSeparator=raw.indexOf("\n\n"),separator=crlfSeparator>=0?crlfSeparator:lfSeparator,separatorLength=crlfSeparator>=0?4:2;
  if(separator<0)reject("UPLOAD_CAPTURE_HTTP_REJECTED");
  const head=raw.slice(0,separator).replace(/\r\n/g,"\n");let body=raw.slice(separator+separatorLength);const lines=head.split("\n");
  const request=/^POST\s+(\S+)\s+HTTP\/1\.1$/i.exec(lines.shift()?.trim()??"");
  if(!request||request[1]!==expectedEndpoint)reject("UPLOAD_CAPTURE_ENDPOINT_REJECTED");
  const headers=new Map();
  for(const line of lines){const colon=line.indexOf(":");if(colon<1)reject("UPLOAD_CAPTURE_HTTP_REJECTED");headers.set(line.slice(0,colon).trim().toLowerCase(),line.slice(colon+1).trim());}
  const length=headers.get("content-length");
  if(length!==undefined){
    if(!/^\d+$/.test(length))reject("UPLOAD_CAPTURE_LENGTH_REJECTED");
    const expected=Number(length),actual=Buffer.byteLength(body,"utf8"),canonicalCrlf=actual+(body.match(/(?<!\r)\n/g)?.length??0);
    // Fiddler's Raw editor may add one display newline when copying all text.
    if(actual===expected+1&&body.endsWith("\n"))body=body.slice(0,-1);
    else if(canonicalCrlf===expected){}
    else if(canonicalCrlf===expected+2&&body.endsWith("\n"))body=body.slice(0,-1);
    else if(actual!==expected)reject("UPLOAD_CAPTURE_LENGTH_REJECTED");
  }
  return{body,contentType:headers.get("content-type")??""};
}

function exactFormKeys(form,expected){
  const keys=[...form.keys()];
  return keys.length===expected.length&&new Set(keys).size===keys.length&&expected.every(key=>keys.includes(key));
}

function parseSqlCapture(kind,body){
  const definition=TEMPLATE_BY_KIND[kind];
  if(!definition)reject("UPLOAD_CAPTURE_KIND_REJECTED");
  const form=new URLSearchParams(body),statementKeys=definition.statementCount===1?["sql"]:Array.from({length:definition.statementCount},(_,index)=>`sql${index}`);
  if(!exactFormKeys(form,["connection","count","command",...statementKeys])||form.get("connection")!==CONNECTION||form.get("count")!==String(definition.statementCount)||form.get("command")!==definition.command)reject("UPLOAD_CAPTURE_FORM_REJECTED");
  const statements=statementKeys.map(key=>form.get(key));
  if(statements.some(value=>typeof value!=="string"||!value.trim()||value.length>256*1024||/;\s*\S/.test(value)))reject("UPLOAD_CAPTURE_SQL_REJECTED");
  if(kind==="attach-insert"&&!/^\s*INSERT\s+INTO\s+opms_attach\s*\(/i.test(statements[0]))reject("UPLOAD_CAPTURE_SQL_REJECTED");
  if(kind==="progress-insert-batch"&&(!/^\s*INSERT\s+INTO\s+opms_app_proc\s*\(/i.test(statements[0])||!/^\s*SELECT\s+scope_identity\s*\(\s*\)\s+AS\s+(?:idx|'idx')\s*$/i.test(statements[1])))reject("UPLOAD_CAPTURE_SQL_REJECTED");
  if(kind==="history-batch"&&statements.some(value=>!/^\s*INSERT\s+INTO\s+opms_history\s*\(/i.test(value)))reject("UPLOAD_CAPTURE_SQL_REJECTED");
  if(kind==="progress-readback"&&!/\bFROM\s+opms_app_proc\b/i.test(statements[0]))reject("UPLOAD_CAPTURE_SQL_REJECTED");
  if(kind==="attachment-readback"&&!/\bFROM\s+opms_attach\b/i.test(statements[0]))reject("UPLOAD_CAPTURE_SQL_REJECTED");
  const envelope={templateId:definition.templateId,command:definition.command,statements};
  return Object.freeze({kind,definition,envelope,fingerprint:fingerprintDomesticReportMutationEnvelope(envelope),statementTables:statements.map(statement=>/^\s*(?:INSERT\s+INTO|UPDATE)\s+([A-Za-z0-9_]+)/i.exec(statement)?.[1]?.toLowerCase()??(/^\s*SELECT\s+scope_identity\s*\(/i.test(statement)?"scope_identity":null))});
}

function parseUploadShape(body,contentType){
  const boundary=/^multipart\/form-data\s*;\s*boundary=(.+)$/i.exec(contentType)?.[1];
  if(!boundary||boundary.length<8||boundary.length>200)reject("UPLOAD_CAPTURE_MULTIPART_REJECTED");
  body=body.replace(/\r\n/g,"\n");const escaped=boundary.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),parts=body.split(new RegExp(`--${escaped}(?:--)?\\n`)).filter(part=>part.trim());
  const fields=[];
  for(const part of parts){
    const split=part.indexOf("\n\n");if(split<0)reject("UPLOAD_CAPTURE_MULTIPART_REJECTED");
    const partHead=part.slice(0,split);
    const disposition=/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(partHead);
    if(!disposition)reject("UPLOAD_CAPTURE_MULTIPART_REJECTED");
    const value=part.slice(split+2).replace(/\n$/,"");
    const partContentType=/^Content-Type:\s*([^\s;]+)(?:\s*;[^\n]*)?$/im.exec(partHead)?.[1]?.toLowerCase()??null;
    if(partContentType!==null&&!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(partContentType))reject("UPLOAD_CAPTURE_MULTIPART_REJECTED");
    fields.push({name:disposition[1],file:disposition[2]!==undefined,value,partContentType});
  }
  if(fields.length!==3||fields[0]?.name!=="connection"||fields[0].file||fields[0].value!==UPLOAD_CONNECTION||fields[1]?.name!=="command"||fields[1].file||fields[1].value!=="upload"||fields[2]?.name!=="file"||!fields[2].file)reject("UPLOAD_CAPTURE_MULTIPART_REJECTED");
  return Object.freeze({kind:"file-transfer",endpoint:UPLOAD_ENDPOINT,connection:UPLOAD_CONNECTION,command:"upload",fieldOrder:["connection","command","file"],filePartName:"file",filePartContentType:fields[2].partContentType,capturedFilePayloadBytes:Buffer.byteLength(fields[2].value,"utf8")});
}

export function inspectDomesticReportUploadCapture({kind,raw}){
  const request=splitRawRequest(raw,kind==="file-transfer"?UPLOAD_ENDPOINT:ENDPOINT);
  if(kind==="file-transfer")return parseUploadShape(request.body,request.contentType);
  if(!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(request.contentType))reject("UPLOAD_CAPTURE_CONTENT_TYPE_REJECTED");
  return parseSqlCapture(kind,request.body);
}

export const DOMESTIC_REPORT_CAPTURE_DEFINITIONS=TEMPLATE_BY_KIND;

export function fingerprintDomesticReportMutationEnvelope(envelope){
  if(!envelope||typeof envelope.templateId!=="string"||!envelope.templateId||!Array.isArray(envelope.statements)||!envelope.statements.length||!new Set(["INSERT","OTHERS","SELECT"]).has(envelope.command)||envelope.command==="SELECT"&&!new Set(["matter-progress.readback.v1","matter-progress.attachment-readback.v1"]).has(envelope.templateId))reject("UPLOAD_CAPTURE_ENVELOPE_REJECTED");
  const statementFingerprints=envelope.statements.map(statement=>{
    if(typeof statement!=="string"||!statement.trim())reject("UPLOAD_CAPTURE_ENVELOPE_REJECTED");
    return createHash("sha256").update(statement.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").trim(),"utf8").digest("hex");
  });
  return createHash("sha256").update(JSON.stringify({command:envelope.command,statementFingerprints}),"utf8").digest("hex");
}
