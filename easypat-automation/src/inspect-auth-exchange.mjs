import {assessCapturedAuthenticationExchange} from "./protocol/authentication-exchange.mjs";
const chunks=[];let size=0;
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>3*1024*1024)throw new Error();chunks.push(chunk);}
  const input=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
  if(!input||Object.keys(input).sort().join(",")!=="cookieContinuity,requestCopied,responseContentType,responseText")throw new Error();
  console.log(JSON.stringify(assessCapturedAuthenticationExchange({...input,framing:"observed-jbori"})));
}catch{
  console.error(JSON.stringify({status:"rejected",reason:"authentication exchange inspection failed",sensitiveValuesIncluded:false,executable:false}));process.exitCode=1;
}finally{chunks.forEach(c=>c.fill(0));}
