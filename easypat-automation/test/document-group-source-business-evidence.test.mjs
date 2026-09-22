import test from "node:test";
import assert from "node:assert/strict";
import {inspectDocumentGroupSourceBusinessEvidence} from "../src/protocol/document-group-source-business-evidence.mjs";

const sourceEnvelope={templateId:"matter-detail.document-group-source.v1",command:"SELECT",statements:["SELECT * FROM proc WHERE idx_parent='group-private' AND kind='fixed-private'"]};
const documentEnvelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT * FROM docs WHERE GRP_KEY='group-private'"]};
const mainResult={matterReference:"P261793",templateId:"matter-detail.main-record.v1",columns:["idx","document_group","kind"],rows:[{idx:"matter-private",document_group:"group-private",kind:"fixed-private"}]};
const progressResult={matterReference:"P261793",templateId:"matter-detail.progress-records.v1",columns:["idx","idx_parent","kind"],rows:[{idx:"row-private",idx_parent:"matter-private",kind:"fixed-private"}]};

test("finds the document group source column without returning compared values",()=>{
  const result=inspectDocumentGroupSourceBusinessEvidence({sourceEnvelope,documentEnvelope,mainResult,progressResult});
  assert.equal(result.status,"document-group-source-business-evidence-found");assert.equal(result.documentGroupMatchCount,1);
  assert.deepEqual(result.matches.find(item=>item.documentGroupPredicate),{predicateColumn:"idx_parent",sourceRole:"main-record",sourceColumn:"document_group",matchingRowCount:1,documentGroupPredicate:true});
  assert.doesNotMatch(JSON.stringify(result),/private/);
});

test("reports no document-group source and rejects unrelated result contexts",()=>{
  const result=inspectDocumentGroupSourceBusinessEvidence({sourceEnvelope,documentEnvelope,mainResult:{...mainResult,rows:[{idx:"other",document_group:"other",kind:"fixed-private"}]},progressResult});
  assert.equal(result.status,"document-group-source-business-evidence-not-found");assert.equal(result.documentGroupMatchCount,0);
  assert.throws(()=>inspectDocumentGroupSourceBusinessEvidence({sourceEnvelope,documentEnvelope,mainResult:{...mainResult,matterReference:"PT261129"},progressResult}));
});
