import test from "node:test";
import assert from "node:assert/strict";
import { inspectAuthenticationBatch } from "../src/protocol/authentication-batch.mjs";
function body() {
  return new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"5",command:"OTHERS",...Object.fromEntries(Array.from({length:5},(_,i)=>['sql'+i,"SELECT 'PRIVATE_VALUE' AS value"]))}).toString();
}
test("inspects five form statements without exposing literal values",()=>{
  const r=inspectAuthenticationBatch(body());
  assert.equal(r.statementCount,5);assert.equal(r.sourceFormat,'form-body');assert.equal(r.executable,false);
  assert.ok(!JSON.stringify(r).includes('PRIVATE_VALUE'));
});
test("accepts observed Fiddler key/value copy and rejects ambiguous rows",()=>{
  const copied=[...new URLSearchParams(body())].map(([k,v])=>`Key=${k}; Value=${v}`).join('\r\n');
  assert.equal(inspectAuthenticationBatch(copied).sourceFormat,'fiddler-form-data-copy');
  assert.throws(()=>inspectAuthenticationBatch(copied+'\r\nKey=sql0; Value=SELECT 2'));
});
test("scoped HTTP copy discards header values and reports cookie presence only",()=>{
  const r=inspectAuthenticationBatch('POST /servlet/Jbori HTTP/1.1\r\nHost: mssql2.easypnp.co.kr:8443\r\nCookie: sid=PRIVATE_COOKIE\r\n\r\n'+body());
  assert.equal(r.requestCookieHeaderPresent,true);assert.ok(!JSON.stringify(r).includes('PRIVATE_COOKIE'));
});
test("rejects duplicate fields, masks, mutations, changed targets and wrong batch count",()=>{
  for(const b of [body()+'&sql0=SELECT+1',body().replace('count=5','count=4'),body().replace('SELECT','UPDATE'),body().replace('PRIVATE_VALUE','!!!sanitized!!!'),'POST /other HTTP/1.1\r\nHost: evil.test\r\n\r\n'+body()]){
    assert.throws(()=>inspectAuthenticationBatch(b),e=>e.message==='AUTH_BATCH_REJECTED');
  }
});
