import test from "node:test";
import assert from "node:assert/strict";
import {inspectCapturedDocumentGroupSources} from "../src/protocol/document-group-source.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";

const envelope=(id,sql)=>({templateId:id,command:"SELECT",statements:[sql]});
const candidate=value=>({templateId:value.templateId,fingerprint:fingerprintEnvelope(value)});

test("document group source diagnostic reports only matching field names",()=>{
  const docs=envelope("matter-detail.documents.v1","SELECT * FROM docs WHERE GRP_KEY='private-group'"),main=envelope("matter-detail.main-record.v1","SELECT * FROM matters WHERE idx='matter-key'"),related=envelope("matter-detail.related-counts.v1","SELECT * FROM links WHERE group_id='private-group' AND idx_parent='matter-key'");
  const value=inspectCapturedDocumentGroupSources({documentEnvelope:docs,documentCandidate:candidate(docs),sources:[{envelope:main,candidate:candidate(main)},{envelope:related,candidate:candidate(related)}]});
  assert.deepEqual(value.matches,[{templateId:"matter-detail.related-counts.v1",predicateColumn:"group_id"}]);assert.doesNotMatch(JSON.stringify(value),/private-group|matter-key/);assert.equal(value.serverRequestsPerformed,0);
});

test("document group source diagnostic reports no match and rejects drift",()=>{
  const docs=envelope("matter-detail.documents.v1","SELECT * FROM docs WHERE GRP_KEY='one'"),main=envelope("matter-detail.main-record.v1","SELECT * FROM matters WHERE idx='two'");
  const value=inspectCapturedDocumentGroupSources({documentEnvelope:docs,documentCandidate:candidate(docs),sources:[{envelope:main,candidate:candidate(main)}]});assert.equal(value.status,"captured-document-group-source-not-found");assert.equal(value.matchCount,0);
  assert.throws(()=>inspectCapturedDocumentGroupSources({documentEnvelope:docs,documentCandidate:{...candidate(docs),fingerprint:"0".repeat(64)},sources:[{envelope:main,candidate:candidate(main)}]}),/DOCUMENT_GROUP_SOURCE_REJECTED/);
});
