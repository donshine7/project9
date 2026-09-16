import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {compileAuthenticationBatch,AUTHENTICATION_BATCH_SHAPES} from "../src/protocol/authentication-batch-binding.mjs";
import {extractAuthenticationBatch} from "../src/protocol/authentication-batch.mjs";
import {scanAuthenticationSql} from "../src/protocol/authentication-shape.mjs";
const loginShape=JSON.parse(readFileSync(new URL('../config/protocol-observations/authentication-request-shape.json',import.meta.url))).shape;
function fixture(rightsUser="fixture_user"){
  const values=[[10,120,"'N'"],[1,"'fixture_user'","'N'","'N'","'Y'","'fixture_user'","'fixture_password'"],[...Array.from({length:5},()=>["'Y'","'Y'","''"]).flat(),`'${rightsUser}'`],[],[108]];
  const sqls=AUTHENTICATION_BATCH_SHAPES.map((s,i)=>{let n=0;return (s??loginShape).replaceAll('<value>',()=>String(values[i][n++]));});
  return new URLSearchParams({connection:'EASYPAT_S_SSPAT',count:'5',command:'OTHERS',...Object.fromEntries(sqls.map((s,i)=>['sql'+i,s]))}).toString();
}
test("whole batch binds three user positions and one password, preserving all other statements and literals",()=>{
  const original=fixture(), compiled=compileAuthenticationBatch(original);
  const next=compiled.bind({username:"new'user",password:"new'password"});
  const a=extractAuthenticationBatch(original).envelope.statements,b=extractAuthenticationBatch(next).envelope.statements;
  for(const i of [0,3,4])assert.equal(a[i],b[i]);
  const rights=scanAuthenticationSql(b[2]);
  assert.equal(rights.literalSpans[15].raw,"'new''user'");
  assert.equal(compiled.summary.usernameSlotCount,3);assert.equal(compiled.summary.fixedLiteralCount,23);
  assert.ok(!decodeURIComponent(next).includes('fixture_user'));
});
test("mismatched rights identity, changed query order or changed fixed query shape are rejected",()=>{
  assert.throws(()=>compileAuthenticationBatch(fixture('other_user')),/AUTH_BATCH_TEMPLATE_REJECTED/);
  const fields=new URLSearchParams(fixture());
  fields.set('sql3','SELECT 1');assert.throws(()=>compileAuthenticationBatch(fields.toString()),/AUTH_BATCH_TEMPLATE_REJECTED/);
});
test("invalid inputs cannot expose original credentials or return a usable session",()=>{
  const compiled=compileAuthenticationBatch(fixture());
  assert.throws(()=>compiled.bind({username:'u',password:'PRIVATE\n'}),e=>e.message==='AUTH_BATCH_BINDING_REJECTED');
  assert.ok(!JSON.stringify(compiled).includes('fixture_'));
  assert.equal(compiled.summary.executable,false);assert.equal(compiled.summary.authenticationVerified,false);
});
