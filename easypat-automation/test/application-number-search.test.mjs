import test from "node:test";
import assert from "node:assert/strict";
import {normalizeExactApplicationNumber} from "../src/protocol/application-number.mjs";
import {createApplicationNumberSearch} from "../src/protocol/application-number-search.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const repeated=(select)=>["a","b","c","d"].map((table,index)=>`${index?"UNION ALL ":""}${select(table)} WHERE ourref LIKE '%P261793%'`).join(" ");
const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:[repeated(table=>`SELECT count(*) AS recCount FROM ${table}`)]};
const resultEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:[repeated(table=>`SELECT idx, ourref, n_app, app_right, title_kor, status, applicant FROM ${table}`)]};
const baseDefinition=(envelope)=>({
  templateId:envelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(envelope),productionEnabled:true,
  parameterization:{mode:"repeated-like-contains",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793",expectedOccurrenceCount:4},
});
const countDefinition={...baseDefinition(countEnvelope),responseCountColumn:"recCount",expectedResponseColumns:["recCount"]};
const columns=["idx","ourref","n_app","app_right","title_kor","status","applicant"];
const searchDefinition={...baseDefinition(resultEnvelope),responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:columns};
const derivation={sourcePredicateColumn:"ourref",targetPredicateColumn:"n_app",responseApplicationNumberColumn:"n_app",maximumSearchCandidateCount:500};
const templates=new Map([[countEnvelope.templateId,countEnvelope],[resultEnvelope.templateId,resultEnvelope]]);

function setup({count="2",rows}={}){
  const calls=[];
  const lookup=createApplicationNumberSearch({countDefinition,searchDefinition,derivation,loadTemplate:async id=>structuredClone(templates.get(id)),executeRead:async request=>{
    calls.push(request);
    assert.equal((request.envelope.statements[0].match(/n_app LIKE/g)??[]).length,4);
    assert.doesNotMatch(request.envelope.statements[0],/ourref LIKE/);
    if(request.role==="count-application-results")return{templateId:countEnvelope.templateId,columns:["recCount"],rows:[{recCount:count}]};
    return{templateId:resultEnvelope.templateId,columns,rows:rows??[
      {idx:"internal-one",ourref:"P261830",n_app:"10-2026-1234567",app_right:"특허",title_kor:"정확 일치",status:"진행",applicant:"비공개"},
      {idx:"internal-two",ourref:"P261831",n_app:"10-2026-1234567-01",app_right:"특허",title_kor:"부분 일치",status:"진행",applicant:"비공개"},
    ]};
  }});
  return{lookup,calls};
}

test("normalizes supported domestic and PCT application numbers",()=>{
  assert.equal(normalizeExactApplicationNumber("10-2026-1234567"),"10-2026-1234567");
  assert.equal(normalizeExactApplicationNumber("pct/kr2026/012345"),"PCT/KR2026/012345");
  for(const value of [" 10-2026-1234567","10-2026-%","10_2026_1","' OR 1=1--","한글-123"]){
    assert.throws(()=>normalizeExactApplicationNumber(value),/APPLICATION_NUMBER_REJECTED/);
  }
});

test("derives only n_app predicates, exact-filters LIKE candidates, and returns a safe projection",async()=>{
  const {lookup,calls}=setup();
  const result=await lookup.search({applicationNumber:"10-2026-1234567"});
  assert.equal(calls.length,2);
  assert.deepEqual(result,{applicationNumber:"10-2026-1234567",count:1,items:[{matterReference:"P261830",applicationNumber:"10-2026-1234567",rightType:"특허",titleKorean:"정확 일치",status:"진행"}]});
  assert.doesNotMatch(JSON.stringify(result),/internal-|idx|applicant|비공개/);
});

test("returns an empty exact result without issuing the row query when count is zero",async()=>{
  const {lookup,calls}=setup({count:"0",rows:[]});
  assert.deepEqual(await lookup.search({applicationNumber:"10-2099-0000000"}),{applicationNumber:"10-2099-0000000",count:0,items:[]});
  assert.equal(calls.length,1);
});

test("fails closed on excessive counts, schema drift, invalid rows, and caller-supplied controls",async()=>{
  const excessive=setup({count:"501"});
  await assert.rejects(excessive.lookup.search({applicationNumber:"10-2026-1234567"}),error=>error.code==="APPLICATION_SEARCH_READ_REJECTED");
  const invalid=setup({count:"1",rows:[{idx:"x",ourref:"P261830",n_app:"bad value",app_right:"특허",title_kor:"x",status:"x",applicant:"x"}]});
  await assert.rejects(invalid.lookup.search({applicationNumber:"10-2026-1234567"}),error=>error.code==="APPLICATION_SEARCH_READ_REJECTED");
  const safe=setup();
  for(const key of ["sql","url","cookie","retry","idx"]){
    await assert.rejects(safe.lookup.search({applicationNumber:"10-2026-1234567",[key]:"x"}),error=>error.code==="APPLICATION_SEARCH_INPUT_REJECTED");
  }
  assert.equal(safe.calls.length,0);
});
