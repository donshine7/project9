import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFixedReadClient } from "../src/protocol/fixed-read-client.mjs";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";
import { EASYPAT_ENDPOINT } from "../src/protocol/https-transport.mjs";
import { validateProtocolIntent } from "../src/core.mjs";

const policy=JSON.parse(readFileSync(new URL("../config/safety-policy.json",import.meta.url)));
const production=JSON.parse(readFileSync(new URL("../config/read-template-registry.json",import.meta.url)));
const envelope={templateId:"fixture.search",command:"SELECT",statements:["SELECT 'P261793' AS ourref"]};
const registry={algorithm:"sha256",templates:[{templateId:envelope.templateId,enabled:true,operation:"search-matter",role:"search-results",command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(envelope),boundMatterReference:"P261793"}]};
const wire="ourref\r\nchar\r\n20\r\nr\r\n\"P261793\"\r\n";
const input={templateId:envelope.templateId,matterReference:"P261793"};
function setup(overrides={}){
  const calls=[];
  const client=createFixedReadClient({policy,registry,loadTemplate:async()=>structuredClone(envelope),getSessionCookie:async()=>"JSESSIONID=fixture-only",transport:async r=>{calls.push(r);return {status:200,contentType:"text/resultset",text:wire};},...overrides});
  return {client,calls};
}
test("fixed request encodes only verified template and checks exact response reference",async()=>{
  const {client,calls}=setup();const result=await client.read(input);
  assert.deepEqual(result.rows,[{ourref:"P261793"}]);
  assert.equal(calls.length,1);assert.equal(calls[0].endpoint,EASYPAT_ENDPOINT);
  assert.equal(new URLSearchParams(calls[0].body).get("sql"),envelope.statements[0]);
  assert.equal(new URLSearchParams(calls[0].body).get("command"),"SELECT");
});
test("real discovery registry cannot invoke credentials or send requests",async()=>{
  let credentials=0;
  const {client,calls}=setup({registry:production,getSessionCookie:async()=>{credentials++;return "x=y";}});
  await assert.rejects(client.read({templateId:production.templates[0].templateId,matterReference:"P261793"}),/TEMPLATE_NOT_ENABLED/);
  assert.equal(credentials,0);assert.equal(calls.length,0);
});
test("rejects caller SQL, another full reference, and changed fixed templates before network",async()=>{
  const {client,calls}=setup();
  await assert.rejects(client.read({...input,sql:"SELECT 1"}),/INVALID_READ_INPUT/);
  await assert.rejects(client.read({...input,matterReference:"P261793-S1"}),/CAPTURE_MATTER_MISMATCH/);
  const changed=setup({loadTemplate:async()=>({...envelope,statements:["SELECT 2"]})});
  await assert.rejects(changed.client.read(input),/FIXED_TEMPLATE_REJECTED/);
  assert.equal(calls.length+changed.calls.length,0);
});
test("blocks policy violations before loading templates or credentials",async()=>{
  const {client,calls}=setup({policy:{...policy,allowedOperations:[]}});
  await assert.rejects(client.read(input),/POLICY_REJECTED/);assert.equal(calls.length,0);
  for(const suffix of ["?other=1","#fragment"]){
    assert.throws(()=>validateProtocolIntent(policy,{url:EASYPAT_ENDPOINT+suffix,operation:"search-matter"}),/outside/);
  }
});
test("provider and transport failures cannot echo secrets",async()=>{
  for(const override of [
    {loadTemplate:async()=>{throw new Error("private-value");}},
    {getSessionCookie:async()=>{throw new Error("private-value");}},
    {transport:async()=>{throw new Error("private-value");}},
  ]){
    await assert.rejects(setup(override).client.read(input),e=>!String(e).includes("private-value"));
  }
});
test("rejects wrong matter, HTML login response, and missing session provider",async()=>{
  await assert.rejects(setup({transport:async()=>({status:200,contentType:"text/resultset",text:wire.replaceAll("P261793","P261793-S1")})}).client.read(input),/RESPONSE_MATTER_MISMATCH/);
  await assert.rejects(setup({transport:async()=>({status:200,contentType:"text/html",text:"login"})}).client.read(input),/RESULTSET_REJECTED/);
  await assert.rejects(setup({getSessionCookie:undefined}).client.read(input),/SESSION_PROVIDER_REQUIRED/);
});
test("business reads reject credential columns even when the matter matches", async () => {
  for (const column of ["pw", "mobile_refresh_token", "PASSWORD", "api_key"]) {
    const text = `ourref\x01${column}\r\nchar\x01char\r\n20\x0120\r\nr\x01r\r\n"P261793"\x01"PRIVATE_VALUE"\r\n`;
    const {client} = setup({transport: async () => ({status:200,contentType:"text/resultset",text})});
    await assert.rejects(client.read(input), e => e.code === "CREDENTIAL_COLUMNS_REJECTED" && !String(e).includes("PRIVATE_VALUE"));
  }
});

test("main record verifies its fixed predicate against the returned internal identity", async () => {
  const statement="SELECT * FROM example WHERE idx = 'private-internal-key'";
  const mainEnvelope={templateId:"fixture.main",command:"SELECT",statements:[statement]};
  const mainRegistry={algorithm:"sha256",templates:[{
    templateId:mainEnvelope.templateId,enabled:true,operation:"get-matter-detail",role:"main-matter-record",
    command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(mainEnvelope),boundMatterReference:"P261793",
    responseVerification:{mode:"statement-literal-equality",predicateColumn:"idx",responseColumn:"idx"},
  }]};
  const mainWire='idx\x01ourref\r\nchar\x01char\r\n64\x0164\r\nr\x01r\r\n"private-internal-key"\x01"different-display-reference"\r\n';
  const mainPolicy=structuredClone(policy);mainPolicy.directReadConstraints["get-matter-detail"].enabledTemplateIds=["fixture.main"];mainPolicy.directReadConstraints["get-matter-detail"].boundMatterReferences=["P261793"];
  const client=createFixedReadClient({policy:mainPolicy,registry:mainRegistry,loadTemplate:async()=>mainEnvelope,getSessionCookie:async()=>"JSESSIONID=fixture-only",transport:async()=>({status:200,contentType:"text/resultset",text:mainWire})});
  const result=await client.read({templateId:"fixture.main",matterReference:"P261793"});
  assert.equal(result.rows.length,1);
  const wrong=createFixedReadClient({policy:mainPolicy,registry:mainRegistry,loadTemplate:async()=>mainEnvelope,getSessionCookie:async()=>"JSESSIONID=fixture-only",transport:async()=>({status:200,contentType:"text/resultset",text:mainWire.replace("private-internal-key","other-internal-key")})});
  await assert.rejects(wrong.read({templateId:"fixture.main",matterReference:"P261793"}),error=>error.code==="RESPONSE_MATTER_MISMATCH"&&!String(error).includes("internal-key"));
});

test("main record requires matching policy allowlists before credentials or network", async () => {
  const mainEnvelope={templateId:"fixture.main",command:"SELECT",statements:["SELECT * FROM example WHERE idx = 'private-internal-key'"]};
  const mainRegistry={algorithm:"sha256",templates:[{templateId:"fixture.main",enabled:true,operation:"get-matter-detail",role:"main-matter-record",command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(mainEnvelope),boundMatterReference:"P261793",responseVerification:{mode:"statement-literal-equality",predicateColumn:"idx",responseColumn:"idx"}}]};
  let templates=0,credentials=0,requests=0;
  const client=createFixedReadClient({policy,registry:mainRegistry,loadTemplate:async()=>{templates++;return mainEnvelope;},getSessionCookie:async()=>{credentials++;return"JSESSIONID=fixture-only";},transport:async()=>{requests++;throw new Error();}});
  await assert.rejects(client.read({templateId:"fixture.main",matterReference:"P261793"}),error=>error.code==="POLICY_REJECTED");
  assert.deepEqual({templates,credentials,requests},{templates:0,credentials:0,requests:0});
});

test("progress read requires the exact schema and every parent identity", async () => {
  const progressEnvelope={templateId:"fixture.progress",command:"SELECT",statements:["SELECT * FROM progress WHERE idx_parent = 'private-internal-key'"]};
  const progressRegistry={algorithm:"sha256",templates:[{templateId:"fixture.progress",enabled:true,operation:"list-progress",role:"progress-records",command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(progressEnvelope),boundMatterReference:"P261793",responseVerification:{mode:"statement-literal-all-rows",predicateColumn:"idx_parent",responseColumn:"idx_parent"},expectedResponseColumns:["idx","idx_parent","memo"]}]};
  const progressPolicy=structuredClone(policy);progressPolicy.allowedOperations.push("list-progress");progressPolicy.directReadConstraints["list-progress"]={uiNavigationReplayAllowed:false,enabledTemplateIds:["fixture.progress"],boundMatterReferences:["P261793"],exactResponseMatterMatchRequired:true};
  const wire='idx\x01idx_parent\x01memo\r\nchar\x01char\x01char\r\n20\x0120\x01100\r\nr\x01r\x01r\r\n"1"\x01"private-internal-key"\x01"first"\r\n"2"\x01"private-internal-key"\x01"second"\r\n';
  const make=text=>createFixedReadClient({policy:progressPolicy,registry:progressRegistry,loadTemplate:async()=>progressEnvelope,getSessionCookie:async()=>"JSESSIONID=fixture-only",transport:async()=>({status:200,contentType:"text/resultset",text})});
  assert.equal((await make(wire).read({templateId:"fixture.progress",matterReference:"P261793"})).rows.length,2);
  const wrongSchema=wire.replace("idx\x01idx_parent\x01memo","idx_parent\x01idx\x01memo");
  await assert.rejects(make(wrongSchema).read({templateId:"fixture.progress",matterReference:"P261793"}),error=>error.code==="RESPONSE_SCHEMA_MISMATCH");
  const wrongParent=wire.replace('"private-internal-key"\x01"second"','"other-internal-key"\x01"second"');
  await assert.rejects(make(wrongParent).read({templateId:"fixture.progress",matterReference:"P261793"}),error=>error.code==="RESPONSE_MATTER_MISMATCH"&&!String(error).includes("internal-key"));
});

test("document read verifies the exact schema and every fixed predicate across all rows",async()=>{
  const documentEnvelope={templateId:"fixture.documents",command:"SELECT",statements:["SELECT * FROM docs WHERE DELETEFLG='N' AND DOC_NUM=9 AND DIV='domestic' AND GRP_KEY='private-group'"]};
  const documentRegistry={algorithm:"sha256",templates:[{templateId:documentEnvelope.templateId,enabled:true,operation:"list-documents",role:"document-records",command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(documentEnvelope),boundMatterReference:"P261793",responseVerification:{mode:"statement-literal-all-rows",predicateColumn:"GRP_KEY",responseColumn:"GRP_KEY"},responsePredicateSetVerification:{mode:"statement-literals-all-rows",columns:["DELETEFLG","DOC_NUM","DIV","GRP_KEY"]},expectedResponseColumns:["DELETEFLG","DOC_NUM","DIV","GRP_KEY","FILE_NAME"]}]};
  const documentPolicy=structuredClone(policy);documentPolicy.allowedOperations.push("list-documents");documentPolicy.directReadConstraints["list-documents"]={uiNavigationReplayAllowed:false,enabledTemplateIds:[documentEnvelope.templateId],boundMatterReferences:["P261793"],exactResponseMatterMatchRequired:true};
  const wire='DELETEFLG\x01DOC_NUM\x01DIV\x01GRP_KEY\x01FILE_NAME\r\nchar\x01bigint\x01char\x01char\x01char\r\n1\x010\x0120\x0164\x01100\r\nwn\x01wn\x01wn\x01wn\x01wn\r\n"N"\x019\x01"domestic"\x01"private-group"\x01"one.pdf"\r\n"N"\x019\x01"domestic"\x01"private-group"\x01"two.pdf"\r\n';
  const make=text=>createFixedReadClient({policy:documentPolicy,registry:documentRegistry,loadTemplate:async()=>documentEnvelope,getSessionCookie:async()=>"JSESSIONID=fixture-only",transport:async()=>({status:200,contentType:"text/resultset",text})});
  assert.equal((await make(wire).read({templateId:documentEnvelope.templateId,matterReference:"P261793"})).rows.length,2);
  const changed=wire.replace('"N"\x019\x01"domestic"\x01"private-group"\x01"two.pdf"','"N"\x0110\x01"domestic"\x01"private-group"\x01"two.pdf"');
  await assert.rejects(make(changed).read({templateId:documentEnvelope.templateId,matterReference:"P261793"}),error=>error.code==="RESPONSE_PREDICATE_SET_MISMATCH"&&!String(error).includes("private-group"));
});
