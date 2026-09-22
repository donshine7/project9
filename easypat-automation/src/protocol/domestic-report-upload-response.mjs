import path from "node:path";

const MAX_RESPONSE_BYTES=512;
const SAFE_SOURCE_NAME=/^[^\\/:*?"<>|\x00-\x1f]{1,260}\.[A-Za-z0-9]{1,10}$/u;
const SERVER_PATH=/^(20\d{2})\/(0[1-9]|1[0-2])\/([0-2]\d|3[01])\/(20\d{2})(0[1-9]|1[0-2])([0-2]\d|3[01])_\d{8}\.([A-Za-z0-9]{1,10})$/;

export class DomesticReportUploadResponseError extends Error{
  constructor(code){super(code);this.name="DomesticReportUploadResponseError";this.code=code;}
}
const reject=code=>{throw new DomesticReportUploadResponseError(code);};

export function parseDomesticReportUploadResponse(response,{expectedFileName}={}){
  if(!SAFE_SOURCE_NAME.test(expectedFileName??"")||path.win32.basename(expectedFileName)!==expectedFileName)reject("DOMESTIC_REPORT_UPLOAD_RESPONSE_INPUT_REJECTED");
  if(response?.status!==200||!/^text\/html\s*;\s*charset\s*=\s*KSC5601$/i.test(response.contentType??"")||!Buffer.isBuffer(response.bytes)||response.bytes.length<1||response.bytes.length>MAX_RESPONSE_BYTES)reject("DOMESTIC_REPORT_UPLOAD_RESPONSE_REJECTED");
  if(response.bytes.some(byte=>byte<0x21||byte>0x7e))reject("DOMESTIC_REPORT_UPLOAD_RESPONSE_REJECTED");
  const relativePath=response.bytes.toString("ascii"),match=SERVER_PATH.exec(relativePath),expectedExtension=path.extname(expectedFileName).slice(1).toLowerCase();
  if(!match||match[1]!==match[4]||match[2]!==match[5]||match[3]!==match[6]||match[7].toLowerCase()!==expectedExtension)reject("DOMESTIC_REPORT_UPLOAD_RESPONSE_REJECTED");
  const date=new Date(Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])));
  if(date.getUTCFullYear()!==Number(match[1])||date.getUTCMonth()+1!==Number(match[2])||date.getUTCDate()!==Number(match[3]))reject("DOMESTIC_REPORT_UPLOAD_RESPONSE_REJECTED");
  return Object.freeze({uploadedFileName:`upload/app_proc/${relativePath}`,relativePathPatternVerified:true});
}

export function inspectCapturedDomesticReportUploadResponse({raw,expectedFileName}={}){
  if(typeof raw!=="string"||!raw.length||Buffer.byteLength(raw,"utf8")>4096||raw.includes("\0"))reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");
  const separator=raw.indexOf("\r\n\r\n")>=0?"\r\n\r\n":"\n\n",at=raw.indexOf(separator);if(at<0)reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");
  const lines=raw.slice(0,at).replace(/\r\n/g,"\n").split("\n"),status=lines.shift();if(!/^HTTP\/1\.1 200(?:\s|$)/.test(status??""))reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");
  const headers=new Map();for(const line of lines){const colon=line.indexOf(":");if(colon<1)reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");headers.set(line.slice(0,colon).trim().toLowerCase(),line.slice(colon+1).trim());}
  if(headers.get("transfer-encoding")?.toLowerCase()!=="chunked")reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");
  let source=raw.slice(at+separator.length),body="",chunkCount=0;
  while(true){const end=source.indexOf("\r\n");if(end<0)reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");const sizeText=source.slice(0,end);if(!/^[0-9a-fA-F]+$/.test(sizeText))reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");const size=Number.parseInt(sizeText,16);source=source.slice(end+2);if(size===0){if(source!=="\r\n"&&source!=="\r\n\r\n"&&source!=="")reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");break;}if(size<1||size>MAX_RESPONSE_BYTES||Buffer.byteLength(source.slice(0,size),"ascii")!==size||source.slice(size,size+2)!=="\r\n")reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");body+=source.slice(0,size);source=source.slice(size+2);chunkCount++;if(chunkCount>4)reject("DOMESTIC_REPORT_UPLOAD_CAPTURE_REJECTED");}
  const parsed=parseDomesticReportUploadResponse({status:200,contentType:headers.get("content-type")??"",bytes:Buffer.from(body,"ascii")},{expectedFileName});
  return Object.freeze({contentType:"text/html;charset=KSC5601",chunkedTransferCaptured:true,chunkCount,relativePathPatternVerified:parsed.relativePathPatternVerified,extension:path.extname(expectedFileName).slice(1).toLowerCase(),rawPathReturned:false});
}
