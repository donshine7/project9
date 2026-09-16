const TOKEN=/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE=/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
function domainMatches(host,domain){return host===domain||host.endsWith("."+domain);}
function pathMatches(target,scope){return target===scope||(target.startsWith(scope)&&(scope.endsWith("/")||target[scope.length]==="/"));}

// Consumes Set-Cookie only inside the trusted authentication adapter. A lease is
// a local maximum reuse time, not a claim about the server's session lifetime.
export function selectSessionCookie({setCookie,responseUrl,requestUrl,cookieName,now,maxLeaseMs}){
  const reject=()=>{throw new Error("SESSION_COOKIE_REJECTED");};
  if(!Array.isArray(setCookie)||setCookie.length>64||!TOKEN.test(cookieName??"")||!Number.isFinite(now)||!Number.isInteger(maxLeaseMs)||maxLeaseMs<1||maxLeaseMs>24*60*60*1000)reject();
  let response,request;
  try{response=new URL(responseUrl);request=new URL(requestUrl);}catch{reject();}
  if(response.protocol!=="https:"||request.protocol!=="https:"||response.origin!==request.origin||response.username||response.password||request.username||request.password)reject();
  const candidates=[];
  for(const header of setCookie){
    if(typeof header!=="string"||header.length>8192||/[\r\n\0]/.test(header))reject();
    const pieces=header.split(";");
    const pos=pieces[0].indexOf("=");
    if(pos<1)continue;
    const name=pieces[0].slice(0,pos).trim();
    if(name!==cookieName)continue;
    const value=pieces[0].slice(pos+1).trim();
    if(!value||!COOKIE_VALUE.test(value))reject();
    const attributes=new Map();
    for(const piece of pieces.slice(1)){
      const index=piece.indexOf("="),key=(index<0?piece:piece.slice(0,index)).trim().toLowerCase();
      const val=index<0?"":piece.slice(index+1).trim();
      if(!key)continue;
      if(attributes.has(key))reject();
      attributes.set(key,val);
    }
    const domainAttribute=attributes.get("domain");
    if(domainAttribute!==undefined){
      const domain=domainAttribute.replace(/^\./,"").toLowerCase();
      // The response and request origins must match independently above.
      // No public-suffix database is used; this is not a browser cookie jar.
      if(!domain.includes(".")||!domainMatches(response.hostname,domain)||!domainMatches(request.hostname,domain))reject();
    }
    const defaultPath=response.pathname.slice(0,response.pathname.lastIndexOf("/"))||"/";
    const scope=attributes.get("path")?.startsWith("/")?attributes.get("path"):defaultPath;
    if(!pathMatches(request.pathname,scope))continue;
    if(name.startsWith("__Secure-")&&!attributes.has("secure"))reject();
    if(name.startsWith("__Host-")&&(!attributes.has("secure")||attributes.has("domain")||attributes.get("path")!=="/"))reject();
    let expiresAt=now+maxLeaseMs;
    if(attributes.has("max-age")){
      const raw=attributes.get("max-age");
      if(!/^-?\d+$/.test(raw))reject();
      const seconds=Number(raw);
      if(!Number.isSafeInteger(seconds)||seconds<=0)reject();
      expiresAt=Math.min(expiresAt,now+Math.min(seconds,maxLeaseMs/1000)*1000);
    }else if(attributes.has("expires")){
      const serverExpiry=Date.parse(attributes.get("expires"));
      if(!Number.isFinite(serverExpiry)||serverExpiry<=now)reject();
      expiresAt=Math.min(expiresAt,serverExpiry);
    }
    candidates.push({cookie:`${name}=${value}`,expiresAt,expiryBasis:attributes.has("max-age")||attributes.has("expires")?"server-expiry-capped-by-local-lease":"local-lease-only"});
  }
  if(candidates.length!==1)reject();
  return candidates[0];
}
