import{compileStoredAuthenticationTemplate}from"./authentication-template-store.mjs";import{selectSessionCookie}from"./session-cookie.mjs";import{assessCapturedAuthenticationExchange}from"../protocol/authentication-exchange.mjs";import{AUTH_BOOTSTRAP_ENDPOINT,AUTH_BATCH_ENDPOINT}from"../protocol/authentication-transport.mjs";
// Candidate only: requires an injected transport and cannot be consumed by createSessionProvider.
export function createCandidateAuthenticationAdapter({templateStore,expectedFingerprint,transport,now=Date.now,maxLeaseMs=15*60*1000}={}){
  if(!templateStore||typeof templateStore.load!=="function"||!transport||typeof transport.bootstrap!=="function"||typeof transport.postBatch!=="function"||!Number.isInteger(maxLeaseMs)||maxLeaseMs<1||maxLeaseMs>24*60*60*1000)throw new Error("AUTH_CANDIDATE_CONFIGURATION_REJECTED");
  async function validate(credentials){let body=null,cookie=null,response=null;try{
    const compiled=compileStoredAuthenticationTemplate(await templateStore.load(),expectedFingerprint);body=compiled.bind(credentials);
    const bootstrap=await transport.bootstrap();const selected=selectSessionCookie({setCookie:bootstrap.setCookie,responseUrl:bootstrap.responseUrl,requestUrl:AUTH_BATCH_ENDPOINT,cookieName:"JSESSIONID",now:now(),maxLeaseMs});cookie=selected.cookie;
    response=await transport.postBatch({body,cookie});if(response?.status!==200)throw new Error();
    const evidence=assessCapturedAuthenticationExchange({requestCopied:body,responseText:response.text,responseContentType:response.contentType,framing:"observed-jbori",cookieContinuity:true});
    if(evidence.capturedExchangeMatched!==true)throw new Error();
    return {status:"candidate-authentication-validated",cookie,expiresAt:selected.expiresAt,expiryBasis:selected.expiryBasis,identityStatus:evidence.identityStatus,rightsRowCount:evidence.rightsRowCount,capturedExchangeMatched:evidence.capturedExchangeMatched};
  }catch{throw new Error("AUTH_CANDIDATE_VALIDATION_FAILED");}finally{body=null;response=null;}}
  return Object.freeze({verified:false,authenticate:undefined,validate,status:()=>({verified:false,liveEnabled:false,bootstrapEndpoint:AUTH_BOOTSTRAP_ENDPOINT,batchEndpoint:AUTH_BATCH_ENDPOINT})});
}

// Promotion is deliberately limited to the live-verified initial success path.
// Any unexpected/failure response is rejected; no refresh or retry is added here.
export function createVerifiedAuthenticationAdapter({verification,...candidateOptions}={}){
  if(!verification||verification.status!=="live-authentication-validated"||verification.identityStatus!=="identity-row-matched"||verification.rightsRowCount!==8||verification.sessionCookieReceived!==true||verification.sessionCookiePersisted!==false||verification.sessionCookieReturned!==false||verification.automaticRetryPerformed!==false||verification.failureResponseVerified!==false||verification.refreshVerified!==false)throw new Error("AUTH_VERIFICATION_EVIDENCE_REJECTED");
  const candidate=createCandidateAuthenticationAdapter(candidateOptions);
  return Object.freeze({
    verified:true,
    async authenticate(credentials){const result=await candidate.validate(credentials);return{status:"authenticated",cookie:result.cookie,expiresAt:result.expiresAt};},
    status:()=>({verified:true,liveEnabled:true,scope:"initial-success-only",refreshEnabled:false,automaticRetries:0}),
  });
}
