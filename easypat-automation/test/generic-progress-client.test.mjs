import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createGenericProgressClient} from "../src/protocol/generic-progress-client.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const policy=JSON.parse(readFileSync(new URL("../config/safety-policy.json",import.meta.url),"utf8"));
const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:["SELECT count(*) AS recCount FROM matters WHERE ourref='P261793'"]};
const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx,ourref FROM matters WHERE ourref='P261793'"]};
const progressEnvelope={templateId:"matter-detail.progress-records.v1",command:"SELECT",statements:["SELECT * FROM progress WHERE idx_parent='100'"]};
const progressColumns=["serial","sourcecode","idx","idx_parent","no_rec","d_rec","d_noti","rec_doc","rec_div","rec_ck","rec_memo","rec_memo1","rec_memo2","rec_memo3","d_brief_due","d_brief","clerk_br","clerk_br_id","d_opinion_due","d_opinion","op_doc","d_proc","proc_memo","n_extend","d_extend","d_due","d_pre","d_pre_rep","pre_doc","pre_memo","no_pre","judge","clerk","clerk_id","part_class","part_code","part","pre_div","memo","d_sort","d_pat_rep","d_direct","direct_memo","ck_proc","method","d_modify","del_flag","clerk_op","clerk_op_id","d_pre_due","clerk_pr","clerk_pr_id","ck_ids","d_edit","sort"];
const definitions=[
  {templateId:countEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(countEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseCountColumn:"recCount",expectedResponseColumns:["recCount"]},
  {templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(searchEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"]},
  {templateId:progressEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(progressEnvelope),parameterization:{mode:"single-scalar-equality",source:"verified-search-identity",predicateColumn:"idx_parent",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},responseVerification:{mode:"statement-literal-all-rows",predicateColumn:"idx_parent",responseColumn:"idx_parent"},expectedResponseColumns:progressColumns,requiredDistinctNonBaselineMatterValidations:2,completedDistinctNonBaselineMatterValidations:2,validatedNonBaselineMatterReferences:["PT261129","PT261130"]},
];
const registry={productionEnabled:true,authorizedNonBaselineMatterReferences:["PT261129","PT261130"],templates:definitions};
const templates=new Map([[countEnvelope.templateId,countEnvelope],[searchEnvelope.templateId,searchEnvelope],[progressEnvelope.templateId,progressEnvelope]]);
function resultset(columns,rows){const line=values=>values.join("\x01")+"\r\n";return line(columns)+line(columns.map(()=>"char"))+line(columns.map(()=>"2048"))+line(columns.map(()=>"r"))+rows.map(row=>line(columns.map(column=>`"${String(row[column]??"").replaceAll('"','""')}"`))).join("");}

test("production generic progress client executes three SELECT reads and returns 13 safe fields",async()=>{
  const calls=[],row=Object.fromEntries(progressColumns.map(column=>[column,""]));Object.assign(row,{idx:"private-row",idx_parent:"901",no_rec:"1",rec_doc:"의견서",rec_memo:"진행 내용"});
  const responses=[resultset(["recCount"],[{recCount:"1"}]),resultset(["idx","ourref"],[{idx:"901",ourref:"PT261130"}]),resultset(progressColumns,[row])];
  const client=createGenericProgressClient({policy,registry,loadTemplate:async id=>structuredClone(templates.get(id)),getSessionCookie:async()=>"JSESSIONID=fixture-only",transport:async request=>{calls.push(request);return{status:200,contentType:"text/resultset",text:responses[calls.length-1]};}});
  const result=await client.listProgress({matterReference:"PT261130"});assert.equal(result.count,1);assert.equal(result.items[0].description,"진행 내용");assert.equal(calls.length,3);
  assert.ok(calls.every(call=>new URLSearchParams(call.body).get("command")==="SELECT"));assert.doesNotMatch(JSON.stringify(result),/901|private-row|idx_parent|JSESSIONID/);
});

test("generic progress client rejects incomplete validation at construction",()=>{
  const changed=structuredClone(registry);changed.templates[2].completedDistinctNonBaselineMatterValidations=1;
  assert.throws(()=>createGenericProgressClient({policy,registry:changed,loadTemplate:async()=>null,getSessionCookie:async()=>"unused",transport:async()=>null}),/CONFIGURATION_REJECTED/);
});
