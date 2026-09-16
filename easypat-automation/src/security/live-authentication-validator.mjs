import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {AUTH_BOOTSTRAP_ENDPOINT,AUTH_BATCH_ENDPOINT} from "../protocol/authentication-transport.mjs";

function expectedEndpoint(url){const value=new URL(url);return {protocol:value.protocol,hostname:value.hostname,port:value.port,pathname:value.pathname};}
function validatePolicy(policy){
  if(!policy||policy.automaticAuthenticationEnabled!==true||policy.maxAutomaticLoginAttempts!==1||policy.tlsVerificationRequired!==true||policy.mutationOperationsEnabled!==false||policy.arbitrarySqlEnabled!==false||!Array.isArray(policy.authorizedAuthenticationEndpoints)||policy.authorizedAuthenticationEndpoints.length!==2)throw new Error();
  const expected=[{...expectedEndpoint(AUTH_BOOTSTRAP_ENDPOINT),method:"POST",body:"empty"},{...expectedEndpoint(AUTH_BATCH_ENDPOINT),method:"POST",command:"OTHERS",statementCount:5}];
  if(JSON.stringify(policy.authorizedAuthenticationEndpoints)!==JSON.stringify(expected))throw new Error();
}

export function createLiveAuthenticationValidator({policy,getCredentialStatus,readCredential,adapter,attemptGate}={}){
  validatePolicy(policy);
  if(typeof getCredentialStatus!=="function"||typeof readCredential!=="function"||!adapter||adapter.verified!==false||adapter.authenticate!==undefined||typeof adapter.validate!=="function"||!attemptGate||typeof attemptGate.claim!=="function")throw new Error("LIVE_AUTH_VALIDATOR_CONFIGURATION_REJECTED");
  return Object.freeze({async run(){let credentials,claim;try{
    const readiness=await getCredentialStatus();if(readiness?.available!==true||readiness.usernamePresent!==true||readiness.passwordPresent!==true)throw new Error();
    claim=await attemptGate.claim();credentials=await readCredential();
    if(!credentials||typeof credentials.username!=="string"||!credentials.username||typeof credentials.password!=="string"||!credentials.password)throw new Error();
    const result=await adapter.validate(credentials);
    if(result?.status!=="candidate-authentication-validated"||result.identityStatus!=="identity-row-matched"||result.capturedExchangeMatched!==true||!Number.isInteger(result.rightsRowCount)||result.rightsRowCount<1||typeof result.cookie!=="string"||!result.cookie)throw new Error();
    await claim.complete("success");
    return {status:"live-authentication-validated",identityStatus:result.identityStatus,rightsRowCount:result.rightsRowCount,sessionCookieReceived:true,sessionCookiePersisted:false,sessionCookieReturned:false,automaticRetryPerformed:false,liveRuntimeEnabled:false};
  }catch{await claim?.complete("failed");throw new Error("LIVE_AUTHENTICATION_VALIDATION_FAILED");}
  finally{if(credentials){try{credentials.username=null;credentials.password=null;}catch{}credentials=null;}}
  }});
}

export function createLiveAuthenticationAttemptGate({root,now=Date.now}={}){
  const resolved=path.resolve(root),target=path.join(resolved,"live-authentication-attempt.v1.json");
  return Object.freeze({async claim(){
    try{await mkdir(resolved,{recursive:true});const info=await lstat(resolved);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(resolved)).toLowerCase()!==resolved.toLowerCase())throw new Error();
      const attemptedAt=new Date(now()).toISOString();await writeFile(target,JSON.stringify({schemaVersion:1,status:"started",attemptedAt}),{flag:"wx",mode:0o600});let completed=false;
      return Object.freeze({async complete(status){if(completed)return;completed=true;if(status!=="success"&&status!=="failed")return;try{await writeFile(target,JSON.stringify({schemaVersion:1,status,attemptedAt,completedAt:new Date(now()).toISOString()}),{mode:0o600});}catch{}}});
    }catch{throw new Error("LIVE_AUTHENTICATION_ATTEMPT_ALREADY_CLAIMED");}
  }});
}
