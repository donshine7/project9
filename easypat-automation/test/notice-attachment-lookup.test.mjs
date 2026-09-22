import test from "node:test";
import assert from "node:assert/strict";
import {createNoticeAttachmentLookup} from "../src/protocol/notice-attachment-lookup.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";
import {consumeVerifiedDocumentSelection} from "../src/protocol/document-selection-context.mjs";

const countEnvelope={templateId:"matter-search.exact-count.v1",command:"SELECT",statements:["SELECT count(*) AS recCount FROM matters WHERE ourref = 'P261793'"]};
const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx, ourref FROM matters WHERE ourref = 'P261793'"]};
const progressEnvelope={templateId:"matter-detail.progress-records.v1",command:"SELECT",statements:["SELECT idx_parent, no_rec, d_noti, rec_doc, d_due FROM progress WHERE idx_parent = 100"]};
const relatedEnvelope={templateId:"matter-detail.related-counts.v1",command:"SELECT",statements:[`SELECT
  (SELECT count(*) FROM p1 WHERE idx_parent = 100) AS '진행수',
  (SELECT count(*) FROM p2 WHERE idx_parent = 100) AS '연차수',
  (SELECT count(*) FROM p3 WHERE idx_parent = 100) AS '신규성수',
  (SELECT count(*) FROM p4 WHERE idx_parent = 100) AS '연구과제수',
  (SELECT count(*) FROM p5 WHERE idx_parent = 100) AS '우선권수',
  (SELECT count(*) FROM p6 WHERE idx_parent = 100) AS '업무관리수',
  (SELECT count(*) FROM p7 WHERE idx_parent = 100) AS '메모수',
  (SELECT count(*) FROM p8 WHERE idx_parent = 100) AS '메일발송수',
  (SELECT count(*) FROM p9 WHERE idx_parent = 100) AS '보조1',
  (SELECT count(*) FROM p10 WHERE idx_parent = 100) AS '보조2',
  (SELECT count(*) FROM p11 WHERE idx_parent = 100) AS '보조3',
  (SELECT count(*) FROM opms_attach WHERE DELETEFLG = 'N' AND DIV LIKE 'app_%' AND GRP_KEY = 100) AS '첨부수',
  (SELECT count(*) FROM claims WHERE idx_data = 100) AS '청구수'`]};

const progressColumns=["idx_parent","no_rec","d_noti","rec_doc","d_due"];
const documentColumns=["IDX","DIV","GRP_KEY","DOC_NUM","DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_OLD","FILE_NAME_UPLOAD","FILE_SIZE","MEMO","DOWN_COUNT","CK_OPEN","MUID","MUNAME","DELETEFLG","DELETEDT","DELETE_UID","DELETE_UNAME","SORT","USR_DATE","serial","family","_TABLENAME","_SEQ","_PNUMBER","_FILENO"];
const countDefinition={templateId:countEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(countEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseCountColumn:"recCount",expectedResponseColumns:["recCount"]};
const searchDefinition={templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(searchEnvelope),parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"]};
const progressDefinition={templateId:progressEnvelope.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:fingerprintEnvelope(progressEnvelope),parameterization:{mode:"single-scalar-equality",source:"verified-search-identity",predicateColumn:"idx_parent",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},responseVerification:{mode:"statement-literal-all-rows",predicateColumn:"idx_parent",responseColumn:"idx_parent"},expectedResponseColumns:progressColumns};
const documentDefinition={templateId:"matter-detail.documents.matter-candidate.v1",expectedResponseColumns:documentColumns};
const relatedCandidate={templateId:relatedEnvelope.templateId,command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(relatedEnvelope)};
const templates=new Map([[countEnvelope.templateId,countEnvelope],[searchEnvelope.templateId,searchEnvelope],[progressEnvelope.templateId,progressEnvelope],[relatedEnvelope.templateId,relatedEnvelope]]);

function attachmentRow(position,{documentName,fileName,time}){
  const row=Object.fromEntries(documentColumns.map(column=>[column,""]));
  return Object.assign(row,{IDX:String(position),DIV:"app_proc",GRP_KEY:"901",DOC_NAME:documentName,REG_DATE:time,FILE_NAME:fileName,FILE_NAME_UPLOAD:`upload/app_proc/2026/09/11/file-${position}.${fileName.split(".").at(-1)}`,FILE_SIZE:"100",DELETEFLG:"N"});
}

function setup({ambiguousProgress=false,wrongAttachmentCount=false}={}){
  const calls=[];
  const lookup=createNoticeAttachmentLookup({countDefinition,searchDefinition,progressDefinition,documentDefinition,relatedCandidate,loadTemplate:async id=>structuredClone(templates.get(id)),executeRead:async request=>{
    calls.push(request.role);
    if(request.role==="count-results")return{templateId:countEnvelope.templateId,columns:["recCount"],rows:[{recCount:"2"}]};
    if(request.role==="fetch-result-rows")return{templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:[{idx:"901",ourref:"P261487"},{idx:"902",ourref:"P261487-S1"}]};
    if(request.role==="progress-records"){
      const rows=[{idx_parent:"901",no_rec:"7",d_noti:"2026-09-11",rec_doc:"의견제출통지서",d_due:"2027-01-11"}];
      if(ambiguousProgress)rows.push({...rows[0],no_rec:"8"});
      return{templateId:progressEnvelope.templateId,columns:progressColumns,rows};
    }
    if(request.role==="attachment-count")return{templateId:relatedEnvelope.templateId,columns:["진행수","연차수","신규성수","연구과제수","우선권수","첨부수","업무관리수","청구수","메모수","메일발송수"],rows:[{진행수:"1",연차수:"0",신규성수:"0",연구과제수:"0",우선권수:"0",첨부수:wrongAttachmentCount?"4":"3",업무관리수:"0",청구수:"0",메모수:"0",메일발송수:"0"}]};
    return{templateId:"matter-detail.attachments.all.v1",columns:documentColumns,rows:[
      attachmentRow(1,{documentName:"HDR문서",fileName:"official.zip",time:"2026-09-11 09:00:00.000"}),
      attachmentRow(2,{documentName:"중간서류",fileName:"P261487_회사_의견제출통지서.pdf",time:"2026-09-11 09:20:00.000"}),
      attachmentRow(3,{documentName:"중간서류",fileName:"official.fin",time:"2026-09-11 09:20:01.000"}),
    ]};
  }});
  return{lookup,calls};
}

test("selects one exact matter and returns only the verified notice package",async()=>{
  const {lookup,calls}=setup();
  const value=await lookup.list({matterReference:"P261487",progressDocument:"의견제출통지서",noticeDate:"2026-09-11"});
  assert.deepEqual(calls,["count-results","fetch-result-rows","progress-records","attachment-count","matter-attachment-records"]);
  assert.equal(value.noticeKind,"opinion_submission");
  assert.equal(value.sequence,"7");
  assert.equal(value.aggregateAttachmentCount,3);
  assert.equal(value.count,3);
  assert.doesNotMatch(JSON.stringify(value),/upload\/|GRP_KEY|901/);
});

test("requires one exact progress row and an exact aggregate attachment count",async()=>{
  const ambiguous=setup({ambiguousProgress:true});
  await assert.rejects(ambiguous.lookup.list({matterReference:"P261487",progressDocument:"의견제출통지서"}),error=>error.code==="NOTICE_ATTACHMENT_LOOKUP_REJECTED");
  assert.deepEqual(ambiguous.calls,["count-results","fetch-result-rows","progress-records"]);
  const mismatch=setup({wrongAttachmentCount:true});
  await assert.rejects(mismatch.lookup.list({matterReference:"P261487",progressDocument:"의견제출통지서",sequence:"7"}),error=>error.code==="NOTICE_ATTACHMENT_LOOKUP_REJECTED");
  assert.deepEqual(mismatch.calls,["count-results","fetch-result-rows","progress-records","attachment-count","matter-attachment-records"]);
});

test("re-reads the verified package before creating one-use download selections",async()=>{
  const {lookup,calls}=setup();
  const listed=await lookup.list({matterReference:"P261487",progressDocument:"의견제출통지서",noticeDate:"2026-09-11",sequence:"7"});
  const prepared=await lookup.preparePackage({matterReference:"P261487",progressDocument:"의견제출통지서",noticeDate:"2026-09-11",sequence:"7",expectedItems:listed.items});
  assert.equal(calls.length,10);assert.equal(prepared.selections.length,3);assert.doesNotMatch(JSON.stringify(prepared),/upload\/app_proc/);
  const target=consumeVerifiedDocumentSelection(prepared.selections[0]);assert.equal(target.uploadPath,"upload/app_proc/2026/09/11/file-1.zip");
  assert.throws(()=>consumeVerifiedDocumentSelection(prepared.selections[0]),/DOCUMENT_SELECTION_CONTEXT_REJECTED/);
  consumeVerifiedDocumentSelection(prepared.selections[1]);consumeVerifiedDocumentSelection(prepared.selections[2]);
  await assert.rejects(lookup.preparePackage({matterReference:"P261487",progressDocument:"의견제출통지서",noticeDate:"2026-09-11",sequence:"7",expectedItems:[{...listed.items[0],fileSizeBytes:101},...listed.items.slice(1)]}),error=>error.code==="NOTICE_ATTACHMENT_SELECTION_REJECTED");
});

test("rejects SQL, arbitrary document types, and malformed dates before any read",async()=>{
  const {lookup,calls}=setup();
  for(const input of [
    {matterReference:"P261487",progressDocument:"의견제출통지서",sql:"SELECT 1"},
    {matterReference:"P261487",progressDocument:"출원번호통지서"},
    {matterReference:"P261487",progressDocument:"거절결정서",noticeDate:"2026/09/11"},
  ])await assert.rejects(lookup.list(input),error=>error.code==="NOTICE_ATTACHMENT_INPUT_REJECTED");
  assert.deepEqual(calls,[]);
});
