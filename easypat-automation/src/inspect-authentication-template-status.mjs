import {readFileSync} from "node:fs";
import {createAuthenticationTemplateStore,AUTH_TEMPLATE_ID} from "./security/authentication-template-store.mjs";
import {fingerprintEnvelope} from "./protocol/template-fingerprint.mjs";

const safe={templateId:AUTH_TEMPLATE_ID,available:false,decryptableByCurrentUser:false,fingerprintVerified:false,credentialValuesIncluded:false,liveEnabled:false};
try{
  const config=JSON.parse(readFileSync(new URL("../config/authentication-template.json",import.meta.url),"utf8"));
  const store=createAuthenticationTemplateStore({expectedFingerprint:config.fingerprint});
  const template=await store.load();
  console.log(JSON.stringify({...safe,available:true,decryptableByCurrentUser:true,fingerprintVerified:fingerprintEnvelope(template)===config.fingerprint}));
}catch{
  console.log(JSON.stringify(safe));
}
