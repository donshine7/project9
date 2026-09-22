import https from "node:https";
import {randomBytes} from "node:crypto";

export const EASYPAT_MUTATION_ENDPOINT="https://mssql2.easypnp.co.kr:8443/servlet/Jbori";
export const EASYPAT_UPLOAD_ENDPOINT="https://mssql2.easypnp.co.kr:8443/servlet/UploadExecute";
const MAX_RESPONSE=2*1024*1024,MAX_UPLOAD=64*1024*1024;
export class DomesticReportMutationTransportError extends Error{constructor(code){super(code);this.name="DomesticReportMutationTransportError";this.code=code;}}

function validCookie(cookie){return typeof cookie==="string"&&/^JSESSIONID=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(cookie)&&cookie.length<=8192;}
function safeFileName(value){return typeof value==="string"&&/^[^\\/:*?"<>|\x00-\x1f]{1,260}\.pdf$/iu.test(value);}

export function buildDomesticReportMultipartUpload({fileName,bytes,boundary=`----------------${randomBytes(12).toString("hex")}`}={}){
  if(!safeFileName(fileName)||!Buffer.isBuffer(bytes)||bytes.length<5||bytes.length>MAX_UPLOAD||!/^[-A-Za-z0-9]{16,70}$/.test(boundary))throw new DomesticReportMutationTransportError("INVALID_UPLOAD_BODY");
  const dispositionName=fileName,chunks=[
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="connection"\r\n\r\nEASYPAT_S_SSPAT_app_proc\r\n`,`utf8`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="command"\r\n\r\nupload\r\n`,`utf8`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${dispositionName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,`utf8`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`,`ascii`),
  ];
  return Object.freeze({body:Buffer.concat(chunks),contentType:`multipart/form-data; boundary=${boundary}`});
}

export function createDomesticReportMutationTransport({request=https.request,timeoutMs=15000,maxResponseBytes=MAX_RESPONSE}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>MAX_RESPONSE)throw new DomesticReportMutationTransportError("INVALID_MUTATION_TRANSPORT_LIMITS");
  return({endpoint=EASYPAT_MUTATION_ENDPOINT,body,contentType,cookie})=>new Promise((resolve,reject)=>{
    const formRequest=endpoint===EASYPAT_MUTATION_ENDPOINT&&/^application\/x-www-form-urlencoded; charset=utf-8$/i.test(contentType),uploadRequest=endpoint===EASYPAT_UPLOAD_ENDPOINT&&/^multipart\/form-data; boundary=[-A-Za-z0-9]{16,70}$/i.test(contentType);
    if((!formRequest&&!uploadRequest)||(!Buffer.isBuffer(body)&&typeof body!=="string")||Buffer.byteLength(body)>MAX_UPLOAD+8192||typeof contentType!=="string"||!validCookie(cookie)){reject(new DomesticReportMutationTransportError("INVALID_MUTATION_REQUEST"));return;}
    let req,res,timer,settled=false,size=0;const chunks=[];
    const fail=code=>{if(settled)return;settled=true;clearTimeout(timer);chunks.forEach(chunk=>chunk.fill(0));reject(new DomesticReportMutationTransportError(code));res?.destroy();req?.destroy();};timer=setTimeout(()=>fail("MUTATION_REQUEST_TIMEOUT"),timeoutMs);
    try{req=request(endpoint,{method:"POST",rejectUnauthorized:true,minVersion:"TLSv1.2",agent:false,headers:{"Content-Type":contentType,"Content-Length":Buffer.byteLength(body),"Accept-Encoding":"identity","Cache-Control":"no-cache","Cookie":cookie}},response=>{res=response;if(settled){res.destroy();return;}res.on("error",()=>fail("MUTATION_RESPONSE_ERROR"));res.on("aborted",()=>fail("MUTATION_RESPONSE_ABORTED"));res.on("close",()=>{if(!settled)fail("MUTATION_RESPONSE_ABORTED");});if([401,403].includes(res.statusCode)){fail("MUTATION_SESSION_REQUIRED");return;}if(res.statusCode!==200){fail("MUTATION_UNEXPECTED_STATUS");return;}if(res.headers["content-encoding"]&&res.headers["content-encoding"]!=="identity"){fail("MUTATION_UNSUPPORTED_ENCODING");return;}const type=String(res.headers["content-type"]??""),length=res.headers["content-length"];if(!/^(?:text\/(?:integer|resultset|html)|multipart\/mixed)(?:;|$)/i.test(type)){fail("MUTATION_UNEXPECTED_TYPE");return;}if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>maxResponseBytes)){fail("MUTATION_RESPONSE_TOO_LARGE");return;}res.on("data",chunk=>{if(settled)return;const bytes=Buffer.from(chunk);size+=bytes.length;if(size>maxResponseBytes){bytes.fill(0);fail("MUTATION_RESPONSE_TOO_LARGE");return;}chunks.push(bytes);});res.on("end",()=>{if(settled)return;if(res.complete===false||(length!==undefined&&Number(length)!==size)){fail("MUTATION_RESPONSE_INCOMPLETE");return;}const bytes=Buffer.concat(chunks);settled=true;clearTimeout(timer);chunks.forEach(chunk=>chunk.fill(0));resolve({status:200,contentType:type,bytes});});});req.on("error",()=>fail("MUTATION_NETWORK_OR_TLS_ERROR"));req.end(body);}catch{fail("MUTATION_NETWORK_OR_TLS_ERROR");}
  });
}
