import {readFileSync} from "node:fs";import{createCredentialFreeAuthenticationTemplate,createAuthenticationTemplateStore,AUTH_TEMPLATE_ID}from"./security/authentication-template-store.mjs";import{fingerprintEnvelope}from"./protocol/template-fingerprint.mjs";
const chunks=[];let size=0;
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>256*1024)throw new Error();chunks.push(chunk);}
  const copied=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));const template=createCredentialFreeAuthenticationTemplate(copied);
  const config=JSON.parse(readFileSync(new URL("../config/authentication-template.json",import.meta.url),"utf8"));
  if(config.templateId!==AUTH_TEMPLATE_ID||config.credentialFree!==true||config.enabled!==false||config.statementCount!==5||fingerprintEnvelope(template)!==config.fingerprint)throw new Error();
  const store=createAuthenticationTemplateStore({expectedFingerprint:config.fingerprint});let summary;
  try{const current=await store.load();if(fingerprintEnvelope(current)!==config.fingerprint)throw new Error();summary={templateId:AUTH_TEMPLATE_ID,stored:false,alreadyStored:true,roundTripVerified:true,credentialFree:true,protection:"Windows-DPAPI-CurrentUser",liveEnabled:false};}
  catch{const saved=await store.save(template);const current=await store.load();if(fingerprintEnvelope(current)!==config.fingerprint)throw new Error();summary={...saved,alreadyStored:false,roundTripVerified:true};}
  console.log(JSON.stringify(summary));
}catch{console.error(JSON.stringify({status:"rejected",reason:"authentication template storage failed",liveEnabled:false}));process.exitCode=1;}
finally{chunks.forEach(c=>c.fill(0));}
