import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createAuthenticationTransport} from "./protocol/authentication-transport.mjs";
import {createCandidateAuthenticationAdapter} from "./security/authentication-adapter.mjs";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {createLiveAuthenticationAttemptGate,createLiveAuthenticationValidator} from "./security/live-authentication-validator.mjs";
import {getEasyPatCredentialStatus,readEasyPatCredential} from "./security/windows-secrets.mjs";

try{
  const policy=JSON.parse(readFileSync(new URL("../config/safety-policy.json",import.meta.url),"utf8"));
  const config=JSON.parse(readFileSync(new URL("../config/authentication-template.json",import.meta.url),"utf8"));
  if(config.enabled!==false||config.credentialFree!==true||config.roundTripVerified!==true)throw new Error();
  const root=fileURLToPath(new URL("../.local/authentication-user/",import.meta.url));
  const templateStore=createAuthenticationTemplateStore({expectedFingerprint:config.fingerprint,root});
  const adapter=createCandidateAuthenticationAdapter({templateStore,expectedFingerprint:config.fingerprint,transport:createAuthenticationTransport()});
  const validator=createLiveAuthenticationValidator({policy,getCredentialStatus:getEasyPatCredentialStatus,readCredential:readEasyPatCredential,adapter,attemptGate:createLiveAuthenticationAttemptGate({root})});
  console.log(JSON.stringify(await validator.run()));
}catch{console.error("LIVE_AUTHENTICATION_VALIDATION_FAILED");process.exitCode=1;}
