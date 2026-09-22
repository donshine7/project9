import test from "node:test";
import assert from "node:assert/strict";
import {inspectMatterDocumentRequest} from "../src/protocol/matter-document-request.mjs";

const envelope=(templateId,sql)=>({templateId,command:"SELECT",statements:[sql]});
const baselines={
  mainEnvelope:envelope("matter-detail.main-record.v1","SELECT * FROM matters WHERE idx='matter-private'"),
  progressEnvelope:envelope("matter-detail.progress-records.v1","SELECT * FROM progress WHERE idx_parent='matter-private'"),
  quarantinedDocumentEnvelope:envelope("matter-detail.documents.v1","SELECT * FROM docs WHERE GRP_KEY='shared-private' AND DELETEFLG='N'"),
};

test("classifies a matter-bound document request without exposing values",()=>{
  const result=inspectMatterDocumentRequest({statement:"SELECT * FROM docs WHERE GRP_KEY='matter-private' AND DELETEFLG='N'",...baselines});
  assert.equal(result.sourceClassification,"matter-bound-document-candidate");
  assert.equal(result.matterBindingObserved,true);assert.equal(result.quarantinedGroupBindingObserved,false);
  assert.deepEqual(result.matterIdentityPredicateColumns,["GRP_KEY"]);
  assert.doesNotMatch(JSON.stringify({...result,envelope:undefined}),/private/);
});

test("quarantines the shared document query and rejects mutations",()=>{
  const repeated=inspectMatterDocumentRequest({statement:baselines.quarantinedDocumentEnvelope.statements[0],...baselines});
  assert.equal(repeated.sourceClassification,"quarantined-shared-document-query");
  assert.equal(repeated.quarantinedGroupBindingObserved,true);assert.equal(repeated.sameAsQuarantinedDocumentStatement,true);
  assert.throws(()=>inspectMatterDocumentRequest({statement:"UPDATE docs SET DELETEFLG='Y' WHERE GRP_KEY='matter-private'",...baselines}));
  assert.throws(()=>inspectMatterDocumentRequest({statement:"SELECT|WITH)\\s'",...baselines}));
});
