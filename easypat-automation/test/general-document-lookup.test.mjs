import test from "node:test";
import assert from "node:assert/strict";
import {createGeneralDocumentLookup} from "../src/protocol/general-document-lookup.mjs";
import {consumeVerifiedDocumentSelection} from "../src/protocol/document-selection-context.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:["SELECT count(*) AS recCount FROM matters WHERE ourref = 'P261793'"]};
const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx, ourref FROM matters WHERE ourref = 'P261793'"]};
const documentEnvelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT GRP_KEY,DELETEFLG,DOC_NUM,DIV,DOC_NAME,REG_DATE,FILE_NAME,FILE_NAME_UPLOAD,FILE_SIZE FROM docs WHERE DELETEFLG='N' AND DOC_NUM=9 AND DIV='domestic' AND GRP_KEY='100'"]};
const countDefinition={templateId:countEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(countEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseCountColumn:"recCount",expectedResponseColumns:["recCount"]};
const searchDefinition={templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(searchEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"]};
const documentColumns=["GRP_KEY","DELETEFLG","DOC_NUM","DIV","DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE"];
const documentDefinition={templateId:documentEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:false,baseFingerprint:fingerprintEnvelope(documentEnvelope),parameterization:{mode:"single-scalar-equality",source:"verified-search-identity",predicateColumn:"GRP_KEY",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},responsePredicateSetVerification:{mode:"statement-literals-all-rows",columns:["DELETEFLG","DOC_NUM","DIV","GRP_KEY"]},expectedResponseColumns:documentColumns};
const templates=new Map([[countEnvelope.templateId,countEnvelope],[searchEnvelope.templateId,searchEnvelope],[documentEnvelope.templateId,documentEnvelope]]);

function setup({wrongGroup=false,count="1"}={}){
  const calls=[];const lookup=createGeneralDocumentLookup({countDefinition,searchDefinition,documentDefinition,loadTemplate:async id=>structuredClone(templates.get(id)),executeRead:async request=>{
    calls.push(request.role);
    if(request.role==="count-results")return{templateId:countEnvelope.templateId,columns:["recCount"],rows:[{recCount:count}]};
    if(request.role==="fetch-result-rows")return{templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:[{idx:"901",ourref:"PT261130"}]};
    return{templateId:documentEnvelope.templateId,columns:documentColumns,rows:[{GRP_KEY:wrongGroup?"902":"901",DELETEFLG:"N",DOC_NUM:"9",DIV:"domestic",DOC_NAME:"수임서류",REG_DATE:"2026-09-16",FILE_NAME:"수임내역서.pdf",FILE_NAME_UPLOAD:"upload/app_proc/2026/09/16/verified-file.pdf",FILE_SIZE:"12345"}]};
  }});return{lookup,calls};
}

test("generic document lookup derives the group and returns only safe metadata",async()=>{
  const {lookup,calls}=setup();const value=await lookup.list({matterReference:"PT261130"});
  assert.deepEqual(calls,["count-results","fetch-result-rows","document-records"]);assert.equal(value.matterReference,"PT261130");assert.equal(value.items[0].fileName,"수임내역서.pdf");
  assert.doesNotMatch(JSON.stringify(value),/901|GRP_KEY|FILE_NAME_UPLOAD|upload\/app_proc/);
});

test("generic document lookup stops on ambiguous search or response group mismatch",async()=>{
  const zero=setup({count:"0"});await assert.rejects(zero.lookup.list({matterReference:"PT261130"}),error=>error.code==="GENERAL_DOCUMENT_SEARCH_REJECTED");assert.deepEqual(zero.calls,["count-results"]);
  const wrong=setup({wrongGroup:true});await assert.rejects(wrong.lookup.list({matterReference:"PT261130"}),error=>error.code==="GENERAL_DOCUMENT_RESULT_REJECTED");assert.deepEqual(wrong.calls,["count-results","fetch-result-rows","document-records"]);
});

test("generic document lookup rejects SQL and internal-key inputs before network",async()=>{
  const {lookup,calls}=setup();await assert.rejects(lookup.list({matterReference:"PT261130",groupKey:"901"}),error=>error.code==="GENERAL_DOCUMENT_INPUT_REJECTED");await assert.rejects(lookup.list({matterReference:"bad' OR 1=1"}),error=>error.code==="GENERAL_DOCUMENT_INPUT_REJECTED");assert.deepEqual(calls,[]);
});

test("generic document download selection keeps the upload path in an opaque one-time context",async()=>{
  const {lookup,calls}=setup();const context=await lookup.prepareDownload({matterReference:"PT261130",position:1,expectedFileName:"수임내역서.pdf"});
  assert.deepEqual(calls,["count-results","fetch-result-rows","document-records"]);assert.equal(context.serverUploadPathIncluded,false);assert.doesNotMatch(JSON.stringify(context),/upload\/app_proc|verified-file/);
  const target=consumeVerifiedDocumentSelection(context);assert.equal(target.uploadPath,"upload/app_proc/2026/09/16/verified-file.pdf");
  assert.throws(()=>consumeVerifiedDocumentSelection(context),/DOCUMENT_SELECTION_CONTEXT_REJECTED/);
});
