import test from "node:test";
import assert from "node:assert/strict";
import {inspectDocumentGroupIntermediateRequest} from "../src/protocol/document-group-intermediate.mjs";

const mainEnvelope={templateId:"matter-detail.main-record.v1",command:"SELECT",statements:["SELECT * FROM matters WHERE idx='matter-101'"]};
const documentEnvelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT * FROM docs WHERE GRP_KEY='group-202'"]};

test("intermediate request identifies matter and document-group predicate columns without values",()=>{
  const value=inspectDocumentGroupIntermediateRequest({statement:"SELECT idx,idx_parent FROM progress WHERE idx_parent='matter-101' AND kind='safe'",mainEnvelope,documentEnvelope});
  assert.deepEqual(value.matterIdentityPredicateColumns,["idx_parent"]);assert.deepEqual(value.documentGroupPredicateColumns,[]);assert.equal(value.matterIdentityBindingObserved,true);assert.match(value.fingerprint,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify({...value,envelope:undefined}),/matter-101|group-202/);assert.equal(value.serverRequestsPerformed,0);
});

test("intermediate request preserves an unbound read only as non-executable evidence",()=>{
  const value=inspectDocumentGroupIntermediateRequest({statement:"SELECT * FROM progress WHERE idx_parent='other'",mainEnvelope,documentEnvelope});assert.equal(value.matterIdentityBindingObserved,false);assert.deepEqual(value.matterIdentityPredicateColumns,[]);assert.equal(value.executable,false);
});

test("intermediate request rejects writes and masks",()=>{
  for(const statement of ["UPDATE progress SET kind='x' WHERE idx_parent='matter-101'","SELECT * FROM progress WHERE idx_parent='!!!sanitized!!!'","SELECT|WITH)\\s'","SELECT nonsense"]){
    assert.throws(()=>inspectDocumentGroupIntermediateRequest({statement,mainEnvelope,documentEnvelope}));
  }
});
