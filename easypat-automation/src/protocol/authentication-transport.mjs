import https from "node:https";
export const AUTH_BOOTSTRAP_ENDPOINT="https://mssql2.easypnp.co.kr:8443/EASYPAT_S_SSPAT/ip.jsp";
export const AUTH_BATCH_ENDPOINT="https://mssql2.easypnp.co.kr:8443/servlet/Jbori";
const MAX_RESPONSE=2*1024*1024;
export class AuthenticationTransportError extends Error{constructor(code){super(code);this.name="AuthenticationTransportError";this.code=code;}}
export function createAuthenticationTransport({request=https.request,timeoutMs=15000,maxResponseBytes=MAX_RESPONSE}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>MAX_RESPONSE)throw new AuthenticationTransportError("INVALID_AUTH_TRANSPORT_LIMITS");
  function send({endpoint,body,cookie,bootstrap}){return new Promise((resolve,reject)=>{
    if((bootstrap&&endpoint!==AUTH_BOOTSTRAP_ENDPOINT)||(!bootstrap&&endpoint!==AUTH_BATCH_ENDPOINT)||typeof body!=="string"||Buffer.byteLength(body)>MAX_RESPONSE||
      (bootstrap&&body!=="")||(bootstrap&&cookie!==undefined)||(!bootstrap&&(typeof cookie!=="string"||!/^JSESSIONID=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(cookie)))){reject(new AuthenticationTransportError("INVALID_AUTH_REQUEST"));return;}
    let req,res,timer,settled=false,size=0;const chunks=[];
    const fail=code=>{if(settled)return;settled=true;clearTimeout(timer);chunks.forEach(c=>c.fill(0));reject(new AuthenticationTransportError(code));res?.destroy();req?.destroy();};
    timer=setTimeout(()=>fail("AUTH_REQUEST_TIMEOUT"),timeoutMs);
    try{
      const headers={"Content-Type":"application/x-www-form-urlencoded; charset=utf-8","Content-Length":Buffer.byteLength(body),"Accept-Encoding":"identity","Cache-Control":"no-cache"};if(cookie)headers.Cookie=cookie;
      req=request(endpoint,{method:"POST",rejectUnauthorized:true,minVersion:"TLSv1.2",agent:false,headers},response=>{
        res=response;if(settled){res.destroy();return;}res.on("error",()=>fail("AUTH_RESPONSE_ERROR"));res.on("aborted",()=>fail("AUTH_RESPONSE_ABORTED"));res.on("close",()=>{if(!settled)fail("AUTH_RESPONSE_ABORTED");});
        if(res.statusCode!==200){fail("AUTH_UNEXPECTED_STATUS");return;}const type=String(res.headers["content-type"]??"");
        if(bootstrap?!/^text\/html\s*;\s*charset=euc-kr\s*$/i.test(type):!/^multipart\/mixed\s*;\s*boundary=/i.test(type)){fail("AUTH_UNEXPECTED_TYPE");return;}
        if(res.headers["content-encoding"]&&res.headers["content-encoding"]!=="identity"){fail("AUTH_UNSUPPORTED_ENCODING");return;}
        const limit=bootstrap?4096:maxResponseBytes,length=res.headers["content-length"];if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>limit)){fail("AUTH_RESPONSE_TOO_LARGE");return;}
        res.on("data",chunk=>{if(settled)return;const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit){bytes.fill(0);fail("AUTH_RESPONSE_TOO_LARGE");return;}chunks.push(bytes);});
        res.on("end",()=>{if(settled)return;if(res.complete===false||(length!==undefined&&Number(length)!==size)){fail("AUTH_RESPONSE_INCOMPLETE");return;}const bytes=Buffer.concat(chunks);let text="";try{if(!bootstrap)text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{bytes.fill(0);fail("AUTH_INVALID_UTF8");return;}bytes.fill(0);chunks.forEach(c=>c.fill(0));settled=true;clearTimeout(timer);if(bootstrap){const raw=res.headers["set-cookie"],setCookie=Array.isArray(raw)?raw:typeof raw==="string"?[raw]:[];resolve({status:200,responseUrl:AUTH_BOOTSTRAP_ENDPOINT,setCookie});}else resolve({status:200,contentType:type,text});});
      });req.on("error",()=>fail("AUTH_NETWORK_OR_TLS_ERROR"));req.end(body);
    }catch{fail("AUTH_NETWORK_OR_TLS_ERROR");}
  });}
  return Object.freeze({bootstrap:()=>send({endpoint:AUTH_BOOTSTRAP_ENDPOINT,body:"",bootstrap:true}),postBatch:({body,cookie})=>send({endpoint:AUTH_BATCH_ENDPOINT,body,cookie,bootstrap:false})});
}
