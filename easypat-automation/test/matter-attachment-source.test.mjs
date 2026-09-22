import test from "node:test";
import assert from "node:assert/strict";
import {deriveMatterAttachmentListTemplate,selectNoticeAttachmentCandidates,verifyMatterAttachmentList} from "../src/protocol/matter-attachment-source.mjs";
import {bindMatterIdentityDetailTemplate,createMatterIdentityContext} from "../src/protocol/parameterized-read-template.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const relatedEnvelope={templateId:"matter-detail.related-counts.v1",command:"SELECT",statements:["SELECT (SELECT count(*) FROM opms_app_proc WHERE del_flag='N' AND idx_parent=100) AS '진행수', (SELECT count(*) FROM opms_attach WHERE DELETEFLG='N' AND DIV LIKE 'app_%' AND GRP_KEY=100) AS '첨부수'"]};
const relatedCandidate={templateId:relatedEnvelope.templateId,command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope(relatedEnvelope)};
const columns=["IDX","DIV","GRP_KEY","DOC_NUM","DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_OLD","FILE_NAME_UPLOAD","FILE_SIZE","MEMO","DOWN_COUNT","CK_OPEN","MUID","MUNAME","DELETEFLG","DELETEDT","DELETE_UID","DELETE_UNAME","SORT","USR_DATE","serial","family","_TABLENAME","_SEQ","_PNUMBER","_FILENO"];
const searchDefinition={templateId:"matter-search.exact-result.v1",responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"]};

function compiled(){
  const derived=deriveMatterAttachmentListTemplate({relatedEnvelope,relatedCandidate,expectedResponseColumns:columns});
  const context=createMatterIdentityContext({matterReference:"P261487",definition:searchDefinition,searchResult:{templateId:searchDefinition.templateId,columns:["idx","ourref"],rows:[{idx:"987654",ourref:"P261487"}]}});
  return{...derived,compiledEnvelope:bindMatterIdentityDetailTemplate({envelope:derived.envelope,definition:derived.definition,context})};
}

test("derives a fixed read-only attachment list from the verified count subquery",()=>{
  const value=compiled();
  assert.match(value.compiledEnvelope.statements[0],/^SELECT \* FROM opms_attach WHERE DELETEFLG = 'N' AND DIV LIKE 'app_%' AND GRP_KEY = 987654 ORDER BY IDX$/);
  assert.doesNotMatch(JSON.stringify(value.definition),/987654/);
});

test("verifies candidate count, exact group predicates, division pattern, and schema",()=>{
  const value=compiled(),row=Object.fromEntries(columns.map(column=>[column,""]));
  Object.assign(row,{DIV:"app_proc",GRP_KEY:"987654",DELETEFLG:"N"});
  const result={templateId:value.definition.templateId,columns,rows:[row]};
  assert.deepEqual(verifyMatterAttachmentList({result,compiledEnvelope:value.compiledEnvelope,definition:value.definition,divisionLike:value.divisionLike,expectedCount:1}),{verified:true,count:1});
  assert.throws(()=>verifyMatterAttachmentList({result:{...result,rows:[{...row,DIV:"other"}]},compiledEnvelope:value.compiledEnvelope,definition:value.definition,divisionLike:value.divisionLike,expectedCount:1}),/RESULT_REJECTED/);
  assert.throws(()=>verifyMatterAttachmentList({result,compiledEnvelope:value.compiledEnvelope,definition:value.definition,divisionLike:value.divisionLike,expectedCount:2}),/RESULT_REJECTED/);
});

test("selects one contiguous OA package from its header, notice PDF, citations, and official file",()=>{
  const items=[
    {position:1,documentName:"중간서류",registeredAt:"2026-05-08 13:49:44.970",fileName:"P261487_출원번호통지서.pdf",fileSizeBytes:1},
    {position:2,documentName:"HDR문서",registeredAt:"2026-09-11 09:00:00.000",fileName:"official.zip",fileSizeBytes:2},
    {position:3,documentName:"중간서류",registeredAt:"2026-09-11 09:20:00.000",fileName:"P261487_회사_의견제출통지서.pdf",fileSizeBytes:3},
    {position:4,documentName:"중간서류",registeredAt:"2026-09-11 09:20:01.000",fileName:"P261487_회사_의견제출통지서_안용문헌_001.pdf",fileSizeBytes:4},
    {position:5,documentName:"중간서류",registeredAt:"2026-09-11 09:20:02.000",fileName:"official.fin",fileSizeBytes:5},
  ];
  assert.deepEqual(selectNoticeAttachmentCandidates({items,matterReference:"P261487",progressDocument:"의견제출통지서"}).map(item=>item.position),[2,3,4,5]);
});

test("rejects an ambiguous notice anchor or a gap inside the inferred package",()=>{
  const base=[
    {position:1,documentName:"HDR문서",registeredAt:"2026-09-11 09:00:00.000",fileName:"official.zip"},
    {position:2,documentName:"중간서류",registeredAt:"2026-09-11 09:20:00.000",fileName:"P261487_회사_의견제출통지서.pdf"},
  ];
  assert.throws(()=>selectNoticeAttachmentCandidates({items:[...base,{...base[1],position:3}],matterReference:"P261487",progressDocument:"의견제출통지서"}),/SELECTION_REJECTED/);
  assert.throws(()=>selectNoticeAttachmentCandidates({items:[base[0],{position:2,documentName:"중간서류",registeredAt:"2026-09-11 12:20:00.000",fileName:"unrelated.pdf"},{...base[1],position:3}],matterReference:"P261487",progressDocument:"의견제출통지서"}),/SELECTION_REJECTED/);
});

test("selects the requested notice date when the same matter has multiple OA packages",()=>{
  const items=[
    {position:1,documentName:"HDR문서",registeredAt:"2026-04-01 09:00:00.000",fileName:"first.zip",fileSizeBytes:1},
    {position:2,documentName:"중간서류",registeredAt:"2026-04-01 09:20:00.000",fileName:"P261487_회사_의견제출통지서.pdf",fileSizeBytes:2},
    {position:3,documentName:"중간서류",registeredAt:"2026-04-01 09:20:01.000",fileName:"first.fin",fileSizeBytes:3},
    {position:4,documentName:"HDR문서",registeredAt:"2026-09-11 09:00:00.000",fileName:"second.zip",fileSizeBytes:4},
    {position:5,documentName:"중간서류",registeredAt:"2026-09-11 09:20:00.000",fileName:"P261487_회사_의견제출통지서.pdf",fileSizeBytes:5},
    {position:6,documentName:"중간서류",registeredAt:"2026-09-11 09:20:01.000",fileName:"second.fin",fileSizeBytes:6},
  ];
  assert.deepEqual(selectNoticeAttachmentCandidates({items,matterReference:"P261487",progressDocument:"의견제출통지서",noticeDate:"2026-09-11"}).map(item=>item.position),[4,5,6]);
});

test("accepts a uniquely nearest package registered one day after the notice",()=>{
  const items=[
    {position:1,documentName:"HDR문서",registeredAt:"2026-09-10 09:00:00.000",fileName:"official.zip",fileSizeBytes:1},
    {position:2,documentName:"중간서류",registeredAt:"2026-09-10 09:20:00.000",fileName:"P261048_회사_의견제출통지서.pdf",fileSizeBytes:2},
    {position:3,documentName:"중간서류",registeredAt:"2026-09-10 09:20:01.000",fileName:"official.fin",fileSizeBytes:3},
  ];
  assert.deepEqual(selectNoticeAttachmentCandidates({items,matterReference:"P261048",progressDocument:"의견제출통지서",noticeDate:"2026-09-09"}).map(item=>item.position),[1,2,3]);
});
