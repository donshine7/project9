import test from "node:test";
import assert from "node:assert/strict";
import {inspectDocumentGroupProgressBridge} from "../src/protocol/document-group-progress-bridge.mjs";

const columns=["idx","idx_parent",...Array.from({length:53},(_,index)=>`c${index}`)];
const envelope=(templateId,sql)=>({templateId,command:"SELECT",statements:[sql]});
const input={
  mainEnvelope:envelope("matter-detail.main-record.v1","SELECT * FROM matters WHERE idx='matter-private'"),
  progressEnvelope:envelope("matter-detail.progress-records.v1","SELECT * FROM progress WHERE idx_parent='matter-private'"),
  progressResult:{columns,rows:[{idx:"other-private",idx_parent:"matter-private"},{idx:"progress-private",idx_parent:"matter-private"}]},
  intermediateEnvelope:envelope("matter-detail.document-group-intermediate.v2","SELECT * FROM progress WHERE idx='progress-private'"),
  intermediateResult:{columns,rows:[{idx:"progress-private",idx_parent:"matter-private"}]},
  documentEnvelope:envelope("matter-detail.documents.v1","SELECT * FROM docs WHERE GRP_KEY='matter-private'"),
  expectedColumns:columns,
};

test("links one matter-bound progress row through the intermediate response to the document group",()=>{
  const result=inspectDocumentGroupProgressBridge(input);
  assert.equal(result.matchedProgressRowCount,1);assert.equal(result.documentGroupBindingVerified,true);
  assert.doesNotMatch(JSON.stringify(result),/matter-private|progress-private|other-private/);
});

test("rejects an unrelated intermediate row, changed parent, duplicate match, and schema drift",()=>{
  assert.throws(()=>inspectDocumentGroupProgressBridge({...input,intermediateResult:{columns,rows:[{idx:"unrelated",idx_parent:"matter-private"}]}}),error=>error.safeDiagnostic.intermediateRequestReturnedSameIdentity===false);
  assert.throws(()=>inspectDocumentGroupProgressBridge({...input,intermediateResult:{columns,rows:[{idx:"progress-private",idx_parent:"different"}]}}),error=>error.safeDiagnostic.intermediateReturnedDocumentGroup===false);
  assert.throws(()=>inspectDocumentGroupProgressBridge({...input,progressResult:{columns,rows:[input.progressResult.rows[1],input.progressResult.rows[1]]}}),error=>error.safeDiagnostic.matchingProgressRowCount===2);
  assert.throws(()=>inspectDocumentGroupProgressBridge({...input,progressResult:{columns:[...columns].reverse(),rows:input.progressResult.rows}}));
});

test("failed comparisons expose only booleans and counts",()=>{
  try{inspectDocumentGroupProgressBridge({...input,documentEnvelope:envelope("matter-detail.documents.v1","SELECT * FROM docs WHERE GRP_KEY='different-private'")});assert.fail();}
  catch(error){
    assert.deepEqual(Object.keys(error.safeDiagnostic).sort(),["allProgressRowsBoundToTemplate","intermediateRequestReturnedSameIdentity","intermediateReturnedDocumentGroup","matchingProgressRowCount","matchingProgressRowParentMatchedDocumentGroup","progressTemplateBoundToMain","rawValuesReturned"].sort());
    assert.doesNotMatch(JSON.stringify(error.safeDiagnostic),/private/);
  }
});
