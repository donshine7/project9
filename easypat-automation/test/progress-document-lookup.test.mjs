import test from "node:test";
import assert from "node:assert/strict";
import {consumeVerifiedDocumentSelection} from "../src/protocol/document-selection-context.mjs";
import {createProgressDocumentLookup} from "../src/protocol/progress-document-lookup.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:["SELECT count(*) AS recCount FROM matters WHERE ourref = 'P261793'"]};
const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx, ourref FROM matters WHERE ourref = 'P261793'"]};
const progressEnvelope={templateId:"matter-detail.progress-records.v1",command:"SELECT",statements:["SELECT idx, idx_parent, rec_doc, op_doc FROM progress WHERE idx_parent = 100"]};
const intermediateEnvelope={templateId:"matter-detail.document-group-intermediate.v2",command:"SELECT",statements:["SELECT idx, idx_parent, rec_doc FROM progress WHERE idx = 200"]};
const documentEnvelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT GRP_KEY,DELETEFLG,DOC_NUM,DIV,DOC_NAME,REG_DATE,FILE_NAME,FILE_NAME_UPLOAD,FILE_SIZE FROM docs WHERE DELETEFLG='N' AND DOC_NUM=9 AND DIV='domestic' AND GRP_KEY=300"]};
const countDefinition={templateId:countEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(countEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseCountColumn:"recCount",expectedResponseColumns:["recCount"]};
const searchDefinition={templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(searchEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"]};
const progressDefinition={templateId:progressEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(progressEnvelope),parameterization:{mode:"single-scalar-equality",source:"verified-search-identity",predicateColumn:"idx_parent",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},responseVerification:{mode:"statement-literal-all-rows",predicateColumn:"idx_parent",responseColumn:"idx_parent"},expectedResponseColumns:["idx","idx_parent","rec_doc","op_doc"]};
const intermediateDefinition={templateId:intermediateEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(intermediateEnvelope),parameterization:{mode:"single-scalar-equality",source:"trusted-derived-identity",predicateColumn:"idx"},responseVerification:{mode:"statement-literal-equality",predicateColumn:"idx",responseColumn:"idx"},expectedResponseColumns:["idx","idx_parent","rec_doc"]};
const documentColumns=["GRP_KEY","DELETEFLG","DOC_NUM","DIV","DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE"];
const documentDefinition={templateId:documentEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(documentEnvelope),parameterization:{mode:"single-scalar-equality",source:"trusted-derived-identity",predicateColumn:"GRP_KEY"},responsePredicateSetVerification:{mode:"statement-literals-all-rows",columns:["DELETEFLG","DOC_NUM","DIV","GRP_KEY"]},expectedResponseColumns:documentColumns};
const templates=new Map([countEnvelope,searchEnvelope,progressEnvelope,intermediateEnvelope,documentEnvelope].map(envelope=>[envelope.templateId,envelope]));

function setup({duplicateProgress=false,wrongIntermediate=false,wrongGroup=false}={}){
  const calls=[];
  const lookup=createProgressDocumentLookup({countDefinition,searchDefinition,progressDefinition,intermediateDefinition,documentDefinition,loadTemplate:async id=>structuredClone(templates.get(id)),executeRead:async request=>{
    calls.push(request.role);
    if(request.role==="count-results")return{templateId:countEnvelope.templateId,columns:["recCount"],rows:[{recCount:"1"}]};
    if(request.role==="fetch-result-rows")return{templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:[{idx:"101",ourref:"PT261268"}]};
    if(request.role==="progress-records")return{templateId:progressEnvelope.templateId,columns:progressDefinition.expectedResponseColumns,rows:[{idx:"201",idx_parent:"101",rec_doc:"위임계약서 (x)",op_doc:"301"},...(duplicateProgress?[{idx:"202",idx_parent:"101",rec_doc:"위임계약서 (x)",op_doc:"302"}]:[])]};
    if(request.role==="document-group-record")return{templateId:intermediateEnvelope.templateId,columns:intermediateDefinition.expectedResponseColumns,rows:[{idx:wrongIntermediate?"202":"201",idx_parent:"301",rec_doc:"위임계약서 (x)"}]};
    return{templateId:documentEnvelope.templateId,columns:documentColumns,rows:[{GRP_KEY:wrongGroup?"302":"301",DELETEFLG:"N",DOC_NUM:"9",DIV:"domestic",DOC_NAME:"수임서류",REG_DATE:"2026-09-17",FILE_NAME:"수임내역서.pdf",FILE_NAME_UPLOAD:"upload/app_proc/2026/09/17/private.pdf",FILE_SIZE:"3456"}]};
  }});
  return{lookup,calls};
}

test("lists progress-attached documents through the verified five-read identity chain",async()=>{
  const {lookup,calls}=setup();
  const value=await lookup.list({matterReference:"PT261268",progressDocument:"위임계약서 (x)"});
  assert.deepEqual(calls,["count-results","fetch-result-rows","progress-records","document-group-record","progress-document-records"]);
  assert.equal(value.progressDocument,"위임계약서 (x)");assert.equal(value.items[0].fileName,"수임내역서.pdf");
  assert.doesNotMatch(JSON.stringify(value),/101|201|301|GRP_KEY|FILE_NAME_UPLOAD|private\.pdf/);
});

test("keeps the download path in a one-use opaque selection",async()=>{
  const {lookup}=setup();
  const context=await lookup.prepareDownload({matterReference:"PT261268",progressDocument:"위임계약서 (x)",position:1,expectedFileName:"수임내역서.pdf"});
  assert.doesNotMatch(JSON.stringify(context),/upload\/app_proc|private\.pdf/);
  const selected=consumeVerifiedDocumentSelection(context);assert.equal(selected.uploadPath,"upload/app_proc/2026/09/17/private.pdf");
});

test("can derive the document group directly from a verified progress field",async()=>{
  const calls=[];
  const lookup=createProgressDocumentLookup({countDefinition,searchDefinition,progressDefinition,progressGroupSourceColumn:"op_doc",documentDefinition,loadTemplate:async id=>structuredClone(templates.get(id)),executeRead:async request=>{
    calls.push(request.role);
    if(request.role==="count-results")return{templateId:countEnvelope.templateId,columns:["recCount"],rows:[{recCount:"1"}]};
    if(request.role==="fetch-result-rows")return{templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:[{idx:"101",ourref:"PT261268"}]};
    if(request.role==="progress-records")return{templateId:progressEnvelope.templateId,columns:progressDefinition.expectedResponseColumns,rows:[{idx:"201",idx_parent:"101",rec_doc:"위임계약서 (x)",op_doc:"301"}]};
    return{templateId:documentEnvelope.templateId,columns:documentColumns,rows:[{GRP_KEY:"301",DELETEFLG:"N",DOC_NUM:"9",DIV:"domestic",DOC_NAME:"수임서류",REG_DATE:"2026-09-17",FILE_NAME:"수임내역서.pdf",FILE_NAME_UPLOAD:"upload/app_proc/2026/09/17/private.pdf",FILE_SIZE:"3456"}]};
  }});
  const value=await lookup.list({matterReference:"PT261268",progressDocument:"위임계약서 (x)"});
  assert.deepEqual(calls,["count-results","fetch-result-rows","progress-records","progress-document-records"]);assert.equal(value.items[0].fileName,"수임내역서.pdf");
});

test("rejects ambiguous progress rows and broken intermediate or group bindings without retry",async()=>{
  for(const [options,code] of [[{duplicateProgress:true},"PROGRESS_DOCUMENT_PROGRESS_REJECTED"],[{wrongIntermediate:true},"PROGRESS_DOCUMENT_GROUP_REJECTED"],[{wrongGroup:true},"PROGRESS_DOCUMENT_RESULT_REJECTED"]]){
    const {lookup}=setup(options);await assert.rejects(lookup.list({matterReference:"PT261268",progressDocument:"위임계약서 (x)"}),error=>error.code===code);
  }
});

test("rejects SQL and internal identifiers at the public boundary",async()=>{
  const {lookup,calls}=setup();
  await assert.rejects(lookup.list({matterReference:"PT261268",progressDocument:"위임계약서 (x)",idx:"201"}),error=>error.code==="PROGRESS_DOCUMENT_INPUT_REJECTED");
  await assert.rejects(lookup.list({matterReference:"bad' OR 1=1",progressDocument:"위임계약서 (x)"}),error=>error.code==="PROGRESS_DOCUMENT_INPUT_REJECTED");
  assert.deepEqual(calls,[]);
});
