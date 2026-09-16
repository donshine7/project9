import test from "node:test";
import assert from "node:assert/strict";
import {inspectCapturedDocumentGroupBinding} from "../src/protocol/document-group-binding.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const mainEnvelope={templateId:"matter-detail.main-record.v1",command:"SELECT",statements:["SELECT * FROM matters WHERE idx = 'private-101'"]};
const documentEnvelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT * FROM docs WHERE DELETEFLG='N' AND GRP_KEY = 'private-101'"]};
const candidate=envelope=>({templateId:envelope.templateId,fingerprint:fingerprintEnvelope(envelope)});

test("captured document group binding compares identities without returning them",()=>{
  const value=inspectCapturedDocumentGroupBinding({mainEnvelope,documentEnvelope,mainCandidate:candidate(mainEnvelope),documentCandidate:candidate(documentEnvelope)});
  assert.equal(value.valuesMatched,true);assert.equal(value.serverRequestsPerformed,0);
  assert.doesNotMatch(JSON.stringify(value),/private-101/);
});

test("captured document group binding rejects mismatches and fingerprint drift",()=>{
  const other={...documentEnvelope,statements:["SELECT * FROM docs WHERE GRP_KEY='private-102'"]};
  assert.throws(()=>inspectCapturedDocumentGroupBinding({mainEnvelope,documentEnvelope:other,mainCandidate:candidate(mainEnvelope),documentCandidate:candidate(other)}),/DOCUMENT_GROUP_IDENTITY_MISMATCH/);
  assert.throws(()=>inspectCapturedDocumentGroupBinding({mainEnvelope,documentEnvelope,mainCandidate:{...candidate(mainEnvelope),fingerprint:"0".repeat(64)},documentCandidate:candidate(documentEnvelope)}),/DOCUMENT_GROUP_TEMPLATE_REJECTED/);
});
