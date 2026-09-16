import test from "node:test";
import assert from "node:assert/strict";
import { selectSessionCookie } from "../src/security/session-cookie.mjs";
const base={responseUrl:"https://example.test/app/login",requestUrl:"https://example.test/servlet/Jbori",cookieName:"sid",now:100000,maxLeaseMs:60000};
test("selects only the named cookie and caps server expiry",()=>{
  const result=selectSessionCookie({...base,setCookie:["other=ignored; Path=/","sid=fixture; Path=/; Secure; HttpOnly; Max-Age=3600"]});
  assert.equal(result.cookie,"sid=fixture");assert.equal(result.expiresAt,160000);
});
test("session cookies use an explicit local lease and expired cookies are rejected",()=>{
  assert.equal(selectSessionCookie({...base,setCookie:["sid=fixture; Path=/"]}).expiryBasis,"local-lease-only");
  for(const suffix of ["Max-Age=0","Max-Age=-1","Expires=Thu, 01 Jan 1970 00:00:00 GMT"]){
    assert.throws(()=>selectSessionCookie({...base,setCookie:["sid=fixture; Path=/; "+suffix]}),/REJECTED/);
  }
});
test("rejects cross-origin, path mismatch, duplicate session cookies and injected headers",()=>{
  for(const headers of [["sid=fixture; Path=/app"],["sid=fixture"],["sid=one; Path=/","sid=two; Path=/"],["sid=fixture\r\nX: bad; Path=/"],["sid=fixture; Path=/; Domain=other.test"]]){
    assert.throws(()=>selectSessionCookie({...base,setCookie:headers}),/REJECTED/);
  }
  assert.throws(()=>selectSessionCookie({...base,requestUrl:"https://other.test/servlet/Jbori",setCookie:["sid=fixture; Path=/"]}),/REJECTED/);
});
test("path boundaries, repeated attributes and host prefixes are conservative",()=>{
  assert.throws(()=>selectSessionCookie({...base,requestUrl:"https://example.test/application",setCookie:["sid=x; Path=/app"]}),/REJECTED/);
  assert.throws(()=>selectSessionCookie({...base,setCookie:["sid=x; Path=/; Path=/"]}),/REJECTED/);
  assert.throws(()=>selectSessionCookie({...base,cookieName:"__Host-sid",setCookie:["__Host-sid=x; Path=/; Domain=example.test; Secure"]}),/REJECTED/);
});
