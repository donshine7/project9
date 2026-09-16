import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createTemplateStore } from "../src/security/template-store.mjs";
import { createSessionProvider } from "../src/security/session-provider.mjs";
import { getEasyPatCredentialStatus, windowsProtection } from "../src/security/windows-secrets.mjs";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";

const sample={templateId:"fixture.detail",command:"SELECT",statements:["SELECT 'synthetic-private-marker'"]};
const candidates=[{templateId:sample.templateId,command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(sample)}];
function fixtureProtection(){
  const key=randomBytes(32);
  return {
    async protect(bytes){const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",key,iv);return Buffer.concat([iv,c.update(bytes),c.final(),c.getAuthTag()]);},
    async unprotect(bytes){const c=createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(-16));return Buffer.concat([c.update(bytes.subarray(12,-16)),c.final()]);},
  };
}
test("encrypted template store round-trip, exclusive save, tamper rejection and fixed fingerprint",async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"easypat-store-test-"));
  try{
    const store=createTemplateStore({candidates,root,protection:fixtureProtection()});
    const summary=await store.save(sample.templateId,sample);
    assert.equal(summary.liveEnabled,false);
    const encrypted=await readFile(path.join(root,"fixture.detail.dpapi"));
    assert.ok(!encrypted.includes(Buffer.from("synthetic-private-marker")));
    assert.deepEqual(await store.load(sample.templateId),sample);
    await assert.rejects(store.save(sample.templateId,sample),/SAVE_FAILED/);
    await assert.rejects(store.save(sample.templateId,{...sample,statements:["SELECT 2"]}),/SAVE_FAILED/);
    await assert.rejects(store.load("../outside"),/LOAD_FAILED/);
    encrypted[20]^=1;await writeFile(path.join(root,"fixture.detail.dpapi"),encrypted);
    await assert.rejects(store.load(sample.templateId),/LOAD_FAILED/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("actual Windows DPAPI protects and restores synthetic data and rejects tampering",{skip:process.platform!=="win32"},async()=>{
  const original=Buffer.from("DPAPI synthetic fixture only");
  const protectedBytes=await windowsProtection.protect(original);
  assert.ok(!protectedBytes.includes(original));
  const restored=await windowsProtection.unprotect(protectedBytes);
  assert.deepEqual(restored,original);restored.fill(0);
  protectedBytes[Math.floor(protectedBytes.length/2)]^=1;
  await assert.rejects(windowsProtection.unprotect(protectedBytes),/WINDOWS_SECRET_OPERATION_FAILED/);
});
test("credential status reports presence without returning credential values",async()=>{
  const status=await getEasyPatCredentialStatus({runBroker:async operation=>{
    assert.equal(operation,"CredentialStatus");
    return {available:true,usernamePresent:true,passwordPresent:true,password:"must-not-return"};
  }});
  assert.deepEqual(status,{available:true,usernamePresent:true,passwordPresent:true});
  assert.doesNotMatch(JSON.stringify(status),/must-not-return|"password"\s*:/i);
  await assert.rejects(getEasyPatCredentialStatus({runBroker:async()=>({available:false,usernamePresent:true,passwordPresent:false})}),/INVALID_CREDENTIAL_STATUS/);
});
test("unverified login protocol never accesses credentials",async()=>{
  let reads=0;
  const provider=createSessionProvider({readCredential:async()=>{reads++;}});
  await assert.rejects(provider.getSessionCookie(),/AUTH_PROTOCOL_NOT_VERIFIED/);
  assert.equal(reads,0);assert.equal(provider.status().attempted,false);
});
test("parallel requests share one login and invalidated sessions do not loop",async()=>{
  let reads=0,logins=0;
  const provider=createSessionProvider({now:()=>100,readCredential:async()=>{reads++;return {username:"fixture",password:"private-password"};},adapter:{verified:true,authenticate:async()=>{logins++;return {status:"authenticated",cookie:"sid=synthetic",expiresAt:200};}}});
  const results=await Promise.all([provider.getSessionCookie(),provider.getSessionCookie()]);
  assert.deepEqual(results,["sid=synthetic","sid=synthetic"]);assert.equal(reads,1);assert.equal(logins,1);
  provider.invalidate();await assert.rejects(provider.getSessionCookie(),/EXHAUSTED/);
  assert.ok(!JSON.stringify(provider.status()).includes("synthetic"));
});
test("failed or ambiguous authentication is sanitized and attempted only once",async()=>{
  for(const authenticate of [async()=>{throw new Error("private-password");},async()=>({status:"captcha"}),async()=>({status:"authenticated",cookie:"sid=x\r\nInjected:1",expiresAt:200})]){
    let calls=0;
    const provider=createSessionProvider({now:()=>100,readCredential:async()=>({username:"fixture",password:"private-password"}),adapter:{verified:true,authenticate:async c=>{calls++;return authenticate(c);}}});
    await assert.rejects(provider.getSessionCookie(),e=>String(e)==="Error: AUTOMATIC_LOGIN_FAILED");
    await assert.rejects(provider.getSessionCookie(),/EXHAUSTED/);assert.equal(calls,1);
  }
});
test("invalidation during login prevents stale session revival",async()=>{
  let complete;
  const provider=createSessionProvider({now:()=>100,readCredential:async()=>({username:"fixture",password:"fixture"}),adapter:{verified:true,authenticate:()=>new Promise(r=>{complete=r;})}});
  const pending=provider.getSessionCookie();await new Promise(r=>setImmediate(r));provider.invalidate();
  complete({status:"authenticated",cookie:"sid=stale",expiresAt:200});
  await assert.rejects(pending,/LOGIN_FAILED/);assert.equal(provider.status().authenticated,false);
});
