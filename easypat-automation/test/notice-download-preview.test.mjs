import test from "node:test";
import assert from "node:assert/strict";
import {buildNoticeDownloadPreview} from "../src/workflow/notice-download-preview.mjs";

const request=(matter,kind,due,messageId)=>({subject:`[업무요청]${kind==="opinion_submission"?"의견제출통지서 대응":"거절결정서 접수"} [${matter}/회사]`,body:`대응기한: ${due.replaceAll("-",".")}`,messageId,entryId:`entry-${messageId}`});
const assignment=(matter,messageId)=>({subject:`[EASYPAT_S] [${matter}][회사] 건의 업무담당자로 지정되었습니다.`,body:`- OurRef : ${matter}\n- 업무구분 : OA`,messageId,entryId:`entry-${messageId}`});
const progress=(document,...events)=>events.map(([sequence,noticeDate])=>({sequence,noticeDate,document,dueDate:null}));

test("deduplicates paired mail and calculates 1OA and 2OA names from full progress history",()=>{
  const mailRecords=[request("P261487","opinion_submission","2027-01-11","m1"),assignment("P261487","m2"),request("P261610","opinion_submission","2027-01-09","m3"),assignment("P261610","m4"),{...assignment("P261610","m4"),entryId:"duplicate-entry"}];
  const notices=[
    {matterReference:"P261487",noticeKind:"opinion_submission",sequence:"7",noticeDate:"2026-09-11",dueDate:"2027-01-11",count:6,aggregateAttachmentCount:42},
    {matterReference:"P261610",noticeKind:"opinion_submission",sequence:"12",noticeDate:"2026-09-09",dueDate:"2027-01-09",count:6,aggregateAttachmentCount:31},
  ];
  const value=buildNoticeDownloadPreview({mailRecords,notices,progressByMatter:{P261487:progress("의견제출통지서",["7","2026-09-11"]),P261610:progress("의견제출통지서",["3","2026-04-01"],["12","2026-09-09"])}});
  assert.equal(value.uniqueRelevantMailCount,4);assert.equal(value.candidateCount,2);assert.equal(value.readyCount,2);assert.equal(value.totalAttachmentCount,12);
  assert.equal(value.items.find(item=>item.matterReference==="P261487").expectedFileName,"[P261487] 1OA (2026-09-11)(2027-01-11).zip");
  assert.equal(value.items.find(item=>item.matterReference==="P261610").expectedFileName,"[P261610] 2OA (2026-09-09)(2027-01-09).zip");
});

test("uses a separate rejection label and marks a completed notice as a duplicate",()=>{
  const notice={matterReference:"P261487",noticeKind:"rejection_decision",sequence:"8",noticeDate:"2026-10-01",dueDate:"2027-02-01",count:2,aggregateAttachmentCount:44};
  const history={P261487:progress("거절결정서",["4","2026-03-01"],["8","2026-10-01"])};
  const base=buildNoticeDownloadPreview({mailRecords:[request("P261487","rejection_decision","2027-02-01","r1")],notices:[notice],progressByMatter:history});
  assert.equal(base.items[0].rejectionSequence,2);
  assert.equal(base.items[0].oaSequence,null);
  assert.equal(base.items[0].expectedFileName,"[P261487] 거절결정 (2차)(2026-10-01)(2027-02-01).zip");
  const repeated=buildNoticeDownloadPreview({mailRecords:[request("P261487","rejection_decision","2027-02-01","r1")],notices:[notice],progressByMatter:history,ledger:{noticeKeys:[base.items[0].noticeKey],completedNoticeKeys:[base.items[0].noticeKey]}});
  assert.equal(repeated.items[0].status,"duplicate");assert.equal(repeated.items[0].ledgerDisposition,"already_completed");
});

test("holds date conflicts, unresolved OA sequence, and an existing destination name",()=>{
  const notice={matterReference:"P261487",noticeKind:"opinion_submission",sequence:"7",noticeDate:"2026-09-11",dueDate:"2027-01-11",count:6,aggregateAttachmentCount:42};
  const value=buildNoticeDownloadPreview({mailRecords:[request("P261487","opinion_submission","2027-01-10","x1")],notices:[notice],progressByMatter:{P261487:[]},ledger:{packageFileNames:["[P261487] 1OA (2026-09-11)(2027-01-11).zip"]}});
  assert.equal(value.items[0].status,"held");
  assert.deepEqual(value.items[0].holdReasons,["mail_easypat_due_date_mismatch","oa_sequence_unresolved"]);
});
