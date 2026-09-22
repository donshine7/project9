import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createGenericDocumentClient} from "../src/protocol/generic-document-client.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const policy=JSON.parse(readFileSync(new URL("../config/safety-policy.json",import.meta.url),"utf8"));
const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:["SELECT count(*) AS recCount FROM matters WHERE ourref='P261793'"]};
const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx,ourref FROM matters WHERE ourref='P261793'"]};
const documentEnvelope={templateId:"matter-detail.documents.matter-candidate.v1",command:"SELECT",statements:["SELECT GRP_KEY,DELETEFLG,DOC_NUM,DIV,DOC_NAME,REG_DATE,FILE_NAME,FILE_NAME_UPLOAD,FILE_SIZE,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R FROM docs WHERE DELETEFLG='N' AND DOC_NUM=9 AND DIV='domestic' AND GRP_KEY='100'"]};
const documentColumns=["GRP_KEY","DELETEFLG","DOC_NUM","DIV","DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R"];
const definitions=[
  {templateId:countEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(countEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseCountColumn:"recCount",expectedResponseColumns:["recCount"]},
  {templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(searchEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"]},
  {templateId:documentEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(documentEnvelope),parameterization:{mode:"single-scalar-equality",source:"verified-search-identity",predicateColumn:"GRP_KEY",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},responsePredicateSetVerification:{mode:"statement-literals-all-rows",columns:["DELETEFLG","DOC_NUM","DIV","GRP_KEY"]},expectedResponseColumns:documentColumns,requiredDistinctNonBaselineMatterValidations:2,completedDistinctNonBaselineMatterValidations:2,validatedNonBaselineMatterReferences:["PT261129","PT261130"]},
];
const registry={productionEnabled:true,authorizedNonBaselineMatterReferences:["PT261129","PT261130"],templates:definitions};
const templates=new Map([[countEnvelope.templateId,countEnvelope],[searchEnvelope.templateId,searchEnvelope],[documentEnvelope.templateId,documentEnvelope]]);
function resultset(columns,rows){const line=values=>values.join("\x01")+"\r\n";return line(columns)+line(columns.map(()=>"char"))+line(columns.map(()=>"2048"))+line(columns.map(()=>"r"))+rows.map(row=>line(columns.map(column=>`"${String(row[column]??"").replaceAll('"','""')}"`))).join("");}

test("production generic document client executes three SELECT reads and safely returns an empty list",async()=>{
  const calls=[],responses=[resultset(["recCount"],[{recCount:"1"}]),resultset(["idx","ourref"],[{idx:"901",ourref:"PT261130"}]),resultset(documentColumns,[])];
  const client=createGenericDocumentClient({policy,registry,loadTemplate:async id=>structuredClone(templates.get(id)),getSessionCookie:async()=>"JSESSIONID=fixture-only",transport:async request=>{calls.push(request);return{status:200,contentType:"text/resultset",text:responses[calls.length-1]};}});
  const result=await client.listDocuments({matterReference:"PT261130"});
  assert.deepEqual(result,{matterReference:"PT261130",count:0,items:[]});assert.equal(calls.length,3);
  assert.ok(calls.every(call=>new URLSearchParams(call.body).get("command")==="SELECT"));assert.doesNotMatch(JSON.stringify(result),/901|GRP_KEY|JSESSIONID/);
});

test("generic document client rejects incomplete validation at construction",()=>{
  const changed=structuredClone(registry);changed.templates[2].completedDistinctNonBaselineMatterValidations=1;
  assert.throws(()=>createGenericDocumentClient({policy,registry:changed,loadTemplate:async()=>null,getSessionCookie:async()=>"unused",transport:async()=>null}),/CONFIGURATION_REJECTED/);
});
