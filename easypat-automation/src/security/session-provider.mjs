import { readEasyPatCredential } from "./windows-secrets.mjs";

// A verified login adapter must be supplied by trusted code after protocol discovery.
// One automatic login attempt per provider lifecycle; concurrent calls share it.
export function createSessionProvider({adapter,readCredential=readEasyPatCredential,now=Date.now}={}){
  let cookie=null,expiresAt=0,attempted=false,pending=null,generation=0;
  async function getSessionCookie(){
    if(cookie&&expiresAt>now())return cookie;
    cookie=null;
    if(pending)return pending;
    if(!adapter||adapter.verified!==true||typeof adapter.authenticate!=="function")throw new Error("AUTH_PROTOCOL_NOT_VERIFIED");
    if(attempted)throw new Error("AUTOMATIC_LOGIN_ATTEMPT_EXHAUSTED");
    attempted=true;
    const startedGeneration=generation;
    pending=(async()=>{
      let credentials;
      try{
        credentials=await readCredential();
        if(!credentials||typeof credentials.username!=="string"||!credentials.username||typeof credentials.password!=="string"||!credentials.password)throw new Error();
        const result=await adapter.authenticate(credentials);
        if(startedGeneration!==generation||result?.status!=="authenticated"||typeof result.cookie!=="string"||!result.cookie||result.cookie.length>8192||/[^\x20-\x7e]/.test(result.cookie)||!Number.isFinite(result.expiresAt)||result.expiresAt<=now())throw new Error();
        cookie=result.cookie;expiresAt=result.expiresAt;return cookie;
      }catch{throw new Error("AUTOMATIC_LOGIN_FAILED");}
      finally{if(credentials){try{credentials.username=null;credentials.password=null;}catch{ /* Caller-owned frozen records cannot be cleared. */ }}credentials=null;}
    })();
    try{return await pending;}finally{pending=null;}
  }
  return Object.freeze({getSessionCookie,invalidate(){generation++;cookie=null;expiresAt=0;},status(){return {authenticated:!!cookie&&expiresAt>now(),attempted,protocolVerified:adapter?.verified===true};}});
}
