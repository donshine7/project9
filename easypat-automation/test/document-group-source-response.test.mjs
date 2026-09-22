import test from "node:test";
import assert from "node:assert/strict";
import {inspectDocumentGroupSourceResponse} from "../src/protocol/document-group-source-response.mjs";

const columns=["idx","idx_parent",...Array.from({length:53},(_,index)=>`c${index}`)];
const intermediateEnvelope={templateId:"matter-detail.document-group-intermediate.v2",command:"SELECT",statements:["SELECT * FROM progress WHERE idx='target-private'"]};
const documentEnvelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT * FROM docs WHERE GRP_KEY='group-private'"]};

test("reports matching source columns without returning compared values",()=>{
  const value=inspectDocumentGroupSourceResponse({result:{columns,rows:[{idx:"target-private",idx_parent:"group-private"}]},intermediateEnvelope,documentEnvelope,expectedColumns:columns});
  assert.equal(value.status,"document-group-source-response-candidate-found");
  assert.deepEqual(value.intermediateIdentityCandidateColumns,[{column:"idx",matchingRowCount:1}]);
  assert.deepEqual(value.documentGroupCandidateColumns,[{column:"idx_parent",matchingRowCount:1}]);
  assert.doesNotMatch(JSON.stringify(value),/target-private|group-private/);
});

test("reports no candidate and rejects changed schema or row count",()=>{
  const value=inspectDocumentGroupSourceResponse({result:{columns,rows:[{idx:"other",idx_parent:"other"}]},intermediateEnvelope,documentEnvelope,expectedColumns:columns});
  assert.equal(value.status,"document-group-source-response-candidate-not-found");
  assert.throws(()=>inspectDocumentGroupSourceResponse({result:{columns:[...columns].reverse(),rows:[{}]},intermediateEnvelope,documentEnvelope,expectedColumns:columns}));
  assert.throws(()=>inspectDocumentGroupSourceResponse({result:{columns,rows:[{},{}]},intermediateEnvelope,documentEnvelope,expectedColumns:columns}));
});
