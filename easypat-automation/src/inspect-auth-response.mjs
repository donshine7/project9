import {inspectAuthenticationResponseShape} from "./protocol/authentication-response.mjs";
const chunks=[];let size=0;
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>3*1024*1024)throw new Error();chunks.push(chunk);}
  const text=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  const boundary=/^(----------[A-Za-z0-9-]+)/.exec(text)?.[1];if(!boundary)throw new Error();
  console.log(JSON.stringify(inspectAuthenticationResponseShape({text,contentType:"multipart/mixed; boundary="+boundary+";charset=UTF-8",framing:"observed-jbori"})));
}catch{console.error(JSON.stringify({status:"rejected",reason:"response shape inspection failed",sensitiveValuesIncluded:false,executable:false}));process.exitCode=1;}
finally{chunks.forEach(c=>c.fill(0));}
