import test from "node:test";
import assert from "node:assert/strict";
import { progressListFields, projectProgressList } from "../src/protocol/progress-list.mjs";

function source(overrides={}){
  const row={serial:"PRIVATE_SERIAL",sourcecode:"PRIVATE_SOURCE",idx:"PRIVATE_ROW_KEY",idx_parent:"PRIVATE_PARENT_KEY",no_rec:"1",d_rec:"2026-09-15",d_noti:null,rec_doc:"의견서",rec_div:"국내",rec_memo:"진행 내용",d_brief_due:null,d_opinion_due:"2026-09-30",d_proc:"2026-09-15",d_due:"2026-09-30",clerk:"담당자",part:"특허팀",method:"전자",memo:"PRIVATE_MEMO",clerk_id:"PRIVATE_ID",...overrides};
  return{matterReference:"P261793",templateId:"matter-detail.progress-records.v1",columns:Object.keys(row),rows:[row]};
}

test("projects only allowlisted progress business fields",()=>{
  const result=projectProgressList(source());
  assert.deepEqual(Object.keys(result),["matterReference","count","items"]);
  assert.deepEqual(Object.keys(result.items[0]),Object.keys(progressListFields));
  assert.equal(result.items[0].description,"진행 내용");
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SERIAL|PRIVATE_SOURCE|PRIVATE_ROW_KEY|PRIVATE_PARENT_KEY|PRIVATE_MEMO|PRIVATE_ID/);
});

test("supports multiple verified rows and rejects unsafe sources",()=>{
  const two=source();two.rows.push({...two.rows[0],no_rec:"2",rec_memo:"두 번째"});
  assert.equal(projectProgressList(two).count,2);
  assert.equal(projectProgressList({...source(),matterReference:"PT261130"}).matterReference,"PT261130");
  assert.throws(()=>projectProgressList({...source(),matterReference:"unsafe' OR 1=1"}),/SOURCE_REJECTED/);
  const missing=source();delete missing.rows[0].rec_doc;missing.columns=missing.columns.filter(column=>column!=="rec_doc");
  assert.throws(()=>projectProgressList(missing),/SCHEMA_REJECTED/);
  assert.throws(()=>projectProgressList(source({rec_memo:"bad\nvalue"})),/VALUE_REJECTED/);
  assert.throws(()=>projectProgressList({...source(),rows:[]}),/SOURCE_REJECTED/);
});
