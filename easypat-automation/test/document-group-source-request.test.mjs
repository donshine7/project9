import test from "node:test";
import assert from "node:assert/strict";
import {inspectDocumentGroupSourceRequest} from "../src/protocol/document-group-source-request.mjs";

const envelope=(templateId,sql)=>({templateId,command:"SELECT",statements:[sql]});
const baselines={
  mainEnvelope:envelope("matter-detail.main-record.v1","SELECT * FROM matters WHERE idx='matter-private'"),
  progressEnvelope:envelope("matter-detail.progress-records.v1","SELECT * FROM progress WHERE idx_parent='matter-private'"),
  intermediateEnvelope:envelope("matter-detail.document-group-intermediate.v2","SELECT * FROM progress WHERE idx='row-private'"),
  documentEnvelope:envelope("matter-detail.documents.v1","SELECT * FROM docs WHERE GRP_KEY='group-private'"),
};

test("classifies a matter-bound filtered source without returning values",()=>{
  const result=inspectDocumentGroupSourceRequest({statement:"SELECT * FROM progress WHERE idx_parent='matter-private' AND rec_div='fixed'",...baselines});
  assert.equal(result.sourceClassification,"matter-bound-source-candidate");
  assert.deepEqual(result.matterIdentityPredicateColumns,["idx_parent"]);assert.equal(result.sameAsIntermediateStatement,false);
  assert.doesNotMatch(JSON.stringify({...result,envelope:undefined}),/private/);
});

test("classifies an exact repeated row query and rejects unsupported input",()=>{
  const result=inspectDocumentGroupSourceRequest({statement:baselines.intermediateEnvelope.statements[0],...baselines});
  assert.equal(result.sourceClassification,"duplicate-intermediate-query");assert.deepEqual(result.intermediateIdentityPredicateColumns,["idx"]);assert.equal(result.sameAsIntermediateStatement,true);
  assert.throws(()=>inspectDocumentGroupSourceRequest({statement:"SELECT|WITH)\\s'",...baselines}));
  assert.throws(()=>inspectDocumentGroupSourceRequest({statement:"UPDATE progress SET x='matter-private'",...baselines}));
});
