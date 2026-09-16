import test from "node:test";
import assert from "node:assert/strict";
import { matterSummaryFields, projectMatterSummary } from "../src/protocol/matter-summary.mjs";

function source(overrides={}) {
  const row={idx:"private-key",app_right:"PATENT",app_kind:"NORMAL",app_div:"KR",d_app:"20260915",n_app:"10-0000",title_kor:"허용된 명칭",status:"진행",client_tel:"PRIVATE_PHONE",memo:"PRIVATE_MEMO",...overrides};
  return {matterReference:"P261793",templateId:"matter-detail.main-record.v1",columns:Object.keys(row),rows:[row]};
}

test("projects only explicitly allowed business fields", () => {
  const summary=projectMatterSummary(source());
  assert.deepEqual(Object.keys(summary),["matterReference",...Object.keys(matterSummaryFields)]);
  assert.equal(summary.titleKorean,"허용된 명칭");
  assert.doesNotMatch(JSON.stringify(summary),/private-key|PRIVATE_PHONE|PRIVATE_MEMO/);
});

test("supports another valid full matter reference but rejects invalid identity, schema, controls, and multiple rows", () => {
  assert.equal(projectMatterSummary({...source(),matterReference:"P261793-S1"}).matterReference,"P261793-S1");
  assert.throws(()=>projectMatterSummary({...source(),matterReference:"not-a-matter"}),/SOURCE_REJECTED/);
  const missing=source();delete missing.rows[0].status;missing.columns=missing.columns.filter(x=>x!=="status");
  assert.throws(()=>projectMatterSummary(missing),/SCHEMA_REJECTED/);
  assert.throws(()=>projectMatterSummary(source({title_kor:"bad\nvalue"})),/VALUE_REJECTED/);
  const many=source();many.rows.push(many.rows[0]);assert.throws(()=>projectMatterSummary(many),/SOURCE_REJECTED/);
});
