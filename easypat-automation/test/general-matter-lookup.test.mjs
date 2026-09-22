import test from "node:test";
import assert from "node:assert/strict";
import { collectLiteralEqualities } from "../src/protocol/matter-linkage.mjs";
import { createGeneralMatterLookup } from "../src/protocol/general-matter-lookup.mjs";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";

const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx, ourref FROM matters WHERE ourref = 'P261793'"]};
const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:["SELECT count(*) AS recCount FROM matters WHERE ourref = 'P261793'"]};
const countDefinition={
  templateId:countEnvelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(countEnvelope),productionEnabled:false,
  parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},
  responseCountColumn:"recCount",expectedResponseColumns:["recCount"],
};
const detailEnvelope={templateId:"matter-detail.main-record.v1",command:"SELECT",statements:["SELECT idx, app_right, app_kind, app_div, d_app, n_app, title_kor, status FROM matters WHERE idx = 'baseline-private-key'"]};
const searchDefinition={
  templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(searchEnvelope),productionEnabled:false,
  parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},
  responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"],
};
const detailColumns=["idx","app_right","app_kind","app_div","d_app","n_app","title_kor","status"];
const detailDefinition={
  templateId:detailEnvelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(detailEnvelope),productionEnabled:false,
  parameterization:{mode:"single-literal-equality",source:"verified-search-identity",predicateColumn:"idx",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},
  responseVerification:{mode:"statement-literal-equality",predicateColumn:"idx",responseColumn:"idx"},expectedResponseColumns:detailColumns,
};
const templates=new Map([[countEnvelope.templateId,countEnvelope],[searchEnvelope.templateId,searchEnvelope],[detailEnvelope.templateId,detailEnvelope]]);

function setup({count="1",searchRows,wrongDetailIdentity=false}={}){
  const calls=[];
  const lookup=createGeneralMatterLookup({countDefinition,searchDefinition,detailDefinition,loadTemplate:async id=>structuredClone(templates.get(id)),executeRead:async request=>{
    calls.push(request.role);
    if(request.role==="count-results")return {templateId:countEnvelope.templateId,columns:["recCount"],rows:[{recCount:count}]};
    if(request.role==="fetch-result-rows"){
      const matter=collectLiteralEqualities(request.envelope.statements[0]).find(x=>x.column.toLowerCase()==="ourref").literal;
      return {templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:searchRows??[{idx:"runtime-private-key",ourref:matter}]};
    }
    const identity=collectLiteralEqualities(request.envelope.statements[0]).find(x=>x.column.toLowerCase()==="idx").literal;
    return {templateId:detailEnvelope.templateId,columns:detailColumns,rows:[{idx:wrongDetailIdentity?"wrong-private-key":identity,app_right:"PATENT",app_kind:"NORMAL",app_div:"KR",d_app:"20260915",n_app:"10-0000",title_kor:"허용된 명칭",status:"진행"}]};
  }});
  return {lookup,calls};
}

test("runs exact search then identity-bound detail read and returns only the safe projection",async()=>{
  const {lookup,calls}=setup();
  const summary=await lookup.lookupSummary({matterReference:"P261830-S1"});
  assert.deepEqual(calls,["count-results","fetch-result-rows","main-matter-record"]);
  assert.equal(summary.matterReference,"P261830-S1");
  assert.equal(summary.titleKorean,"허용된 명칭");
  assert.doesNotMatch(JSON.stringify(summary),/runtime-private-key|idx/);
});

test("stops after an ambiguous search without retrying or reading detail",async()=>{
  const {lookup,calls}=setup({searchRows:[{idx:"one",ourref:"P261830"},{idx:"two",ourref:"P261830"}]});
  await assert.rejects(lookup.lookupSummary({matterReference:"P261830"}),error=>error.code==="GENERAL_LOOKUP_SEARCH_REJECTED");
  assert.deepEqual(calls,["count-results","fetch-result-rows"]);
});

test("stops after a zero count and rejects a candidate-count mismatch",async()=>{
  const zero=setup({count:"0"});
  await assert.rejects(zero.lookup.lookupSummary({matterReference:"P261830"}),error=>error.code==="GENERAL_LOOKUP_SEARCH_REJECTED");
  assert.deepEqual(zero.calls,["count-results"]);
  const mismatch=setup({count:"2"});
  await assert.rejects(mismatch.lookup.lookupSummary({matterReference:"P261830"}),error=>error.code==="GENERAL_LOOKUP_SEARCH_REJECTED");
  assert.deepEqual(mismatch.calls,["count-results","fetch-result-rows"]);
});

test("selects one exact matter from multiple LIKE candidates",async()=>{
  const {lookup,calls}=setup({count:"2",searchRows:[{idx:"exact-key",ourref:"P261830"},{idx:"partial-key",ourref:"P261830-PRO1"}]});
  const summary=await lookup.lookupSummary({matterReference:"P261830"});
  assert.equal(summary.matterReference,"P261830");
  assert.deepEqual(calls,["count-results","fetch-result-rows","main-matter-record"]);
  assert.doesNotMatch(JSON.stringify(summary),/exact-key|partial-key/);
});

test("rejects a detail identity mismatch without disclosing either identity",async()=>{
  const {lookup,calls}=setup({wrongDetailIdentity:true});
  await assert.rejects(lookup.lookupSummary({matterReference:"P261830"}),error=>error.code==="GENERAL_LOOKUP_DETAIL_REJECTED"&&!/private-key/.test(String(error)));
  assert.deepEqual(calls,["count-results","fetch-result-rows","main-matter-record"]);
});

test("accepts no SQL, URL, cookie, retry, or internal-key arguments",async()=>{
  const {lookup,calls}=setup();
  for(const key of ["sql","url","cookie","retry","idx"]){
    await assert.rejects(lookup.lookupSummary({matterReference:"P261830",[key]:"x"}),error=>error.code==="GENERAL_LOOKUP_INPUT_REJECTED");
  }
  assert.deepEqual(calls,[]);
});
