import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createLiveAuthenticationAttemptGate,createLiveAuthenticationValidator} from "../src/security/live-authentication-validator.mjs";

const policy=JSON.parse(readFileSync(new URL("../config/safety-policy.json",import.meta.url),"utf8"));
const ready=async()=>({available:true,usernamePresent:true,passwordPresent:true});

test("one-time validator returns only safe live evidence and does not persist the cookie",async()=>{
  const events=[];let reads=0,validations=0;
  const validator=createLiveAuthenticationValidator({policy,getCredentialStatus:ready,readCredential:async()=>{reads++;return{username:"fixture",password:"private"};},adapter:{verified:false,authenticate:undefined,validate:async()=>{validations++;return{status:"candidate-authentication-validated",identityStatus:"identity-row-matched",rightsRowCount:8,capturedExchangeMatched:true,cookie:"JSESSIONID=private"};}},attemptGate:{claim:async()=>({complete:async status=>events.push(status)})}});
  const result=await validator.run();assert.equal(result.status,"live-authentication-validated");assert.equal(result.sessionCookiePersisted,false);assert.equal(result.sessionCookieReturned,false);assert.equal(reads,1);assert.equal(validations,1);assert.deepEqual(events,["success"]);assert.doesNotMatch(JSON.stringify(result),/JSESSIONID|private|cookie\s*:/i);
});

test("missing credentials stop before claiming an attempt",async()=>{let claims=0,reads=0;const validator=createLiveAuthenticationValidator({policy,getCredentialStatus:async()=>({available:false,usernamePresent:false,passwordPresent:false}),readCredential:async()=>{reads++;},adapter:{verified:false,authenticate:undefined,validate:async()=>{}},attemptGate:{claim:async()=>{claims++;}}});await assert.rejects(validator.run(),/LIVE_AUTHENTICATION_VALIDATION_FAILED/);assert.equal(claims,0);assert.equal(reads,0);});

test("attempt gate remains claimed after success or failure",async()=>{const root=await mkdtemp(path.join(tmpdir(),"easypat-live-gate-"));try{const gate=createLiveAuthenticationAttemptGate({root,now:()=>100});const claim=await gate.claim();await claim.complete("failed");await assert.rejects(gate.claim(),/ALREADY_CLAIMED/);}finally{await rm(root,{recursive:true,force:true});}});

test("changed authentication policy is rejected before construction",()=>{assert.throws(()=>createLiveAuthenticationValidator({policy:{...policy,maxAutomaticLoginAttempts:2}}),/CONFIGURATION|Error/);});
