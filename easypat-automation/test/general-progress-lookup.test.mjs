import test from "node:test";
import assert from "node:assert/strict";
import { createGeneralProgressLookup } from "../src/protocol/general-progress-lookup.mjs";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";

const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:["SELECT count(*) AS recCount FROM matters WHERE ourref = 'P261793'"]};
const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx, ourref FROM matters WHERE ourref = 'P261793'"]};
const progressEnvelope={templateId:"matter-detail.progress-records.v1",command:"SELECT",statements:["SELECT idx, idx_parent, no_rec, d_rec, d_noti, rec_doc, rec_div, rec_memo, d_brief_due, d_opinion_due, d_proc, d_due, clerk, part, method FROM progress WHERE idx_parent = '100'"]};
const countDefinition={templateId:countEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(countEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseCountColumn:"recCount",expectedResponseColumns:["recCount"]};
const searchDefinition={templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(searchEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"]};
const progressColumns=["idx","idx_parent","no_rec","d_rec","d_noti","rec_doc","rec_div","rec_memo","d_brief_due","d_opinion_due","d_proc","d_due","clerk","part","method"];
const progressDefinition={templateId:progressEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(progressEnvelope),parameterization:{mode:"single-scalar-equality",source:"verified-search-identity",predicateColumn:"idx_parent",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},responseVerification:{mode:"statement-literal-all-rows",predicateColumn:"idx_parent",responseColumn:"idx_parent"},expectedResponseColumns:progressColumns};
const templates=new Map([[countEnvelope.templateId,countEnvelope],[searchEnvelope.templateId,searchEnvelope],[progressEnvelope.templateId,progressEnvelope]]);

function setup({wrongIdentity=false,count="1",searchRows}={}){
  const calls=[];
  const lookup=createGeneralProgressLookup({countDefinition,searchDefinition,progressDefinition,loadTemplate:async id=>structuredClone(templates.get(id)),executeRead:async request=>{
    calls.push(request.role);
    if(request.role==="count-results")return{templateId:countEnvelope.templateId,columns:["recCount"],rows:[{recCount:count}]};
    if(request.role==="fetch-result-rows")return{templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:searchRows??[{idx:"901",ourref:"PT261130"}]};
    const row=Object.fromEntries(progressColumns.map(column=>[column,""]));Object.assign(row,{idx:"PRIVATE_ROW",idx_parent:wrongIdentity?"902":"901",no_rec:"1",rec_doc:"의견서",rec_memo:"진행 내용"});
    return{templateId:progressEnvelope.templateId,columns:progressColumns,rows:[row]};
  }});
  return{lookup,calls};
}

test("generic progress lookup binds the fresh matter identity and projects only 13 business fields",async()=>{
  const {lookup,calls}=setup();const value=await lookup.list({matterReference:"PT261130"});
  assert.deepEqual(calls,["count-results","fetch-result-rows","progress-records"]);
  assert.equal(value.matterReference,"PT261130");assert.equal(value.count,1);assert.equal(value.items[0].description,"진행 내용");
  assert.doesNotMatch(JSON.stringify(value),/901|PRIVATE_ROW|idx_parent/);
});

test("generic progress lookup selects one exact matter from multiple LIKE candidates",async()=>{
  const {lookup,calls}=setup({count:"2",searchRows:[{idx:"901",ourref:"PT261130"},{idx:"902",ourref:"PT261130-US"}]});
  const value=await lookup.list({matterReference:"PT261130"});
  assert.equal(value.matterReference,"PT261130");
  assert.deepEqual(calls,["count-results","fetch-result-rows","progress-records"]);
});

test("generic progress lookup stops on ambiguous search and mismatched progress identity without retry",async()=>{
  const zero=setup({count:"0"});await assert.rejects(zero.lookup.list({matterReference:"PT261130"}),error=>error.code==="GENERAL_PROGRESS_SEARCH_REJECTED");assert.deepEqual(zero.calls,["count-results"]);
  const wrong=setup({wrongIdentity:true});await assert.rejects(wrong.lookup.list({matterReference:"PT261130"}),error=>error.code==="GENERAL_PROGRESS_RESULT_REJECTED");assert.deepEqual(wrong.calls,["count-results","fetch-result-rows","progress-records"]);
});

test("generic progress lookup accepts only a full matter reference argument",async()=>{
  const {lookup,calls}=setup();
  await assert.rejects(lookup.list({matterReference:"PT261130",sql:"SELECT 1"}),error=>error.code==="GENERAL_PROGRESS_INPUT_REJECTED");
  await assert.rejects(lookup.list({matterReference:"bad' OR 1=1"}),error=>error.code==="GENERAL_PROGRESS_INPUT_REJECTED");
  assert.deepEqual(calls,[]);
});
