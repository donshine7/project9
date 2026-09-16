import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";
import { inspectDocumentBroadPredicateEvidence, inspectDocumentPredicateEvidence, inspectDocumentProgressLinkage } from "../src/protocol/document-linkage.mjs";

const statement="SELECT * FROM docs WHERE GRP_KEY = 'private-progress-key' AND DELETEFLG = 'N'";
const candidate={sessionId:247,templateId:"matter-detail.documents.v1",command:"SELECT",statementCount:1,fingerprint:fingerprintEnvelope({templateId:"matter-detail.documents.v1",command:"SELECT",statements:[statement]})};
const expected=["IDX","DIV","GRP_KEY",...Array.from({length:24},(_,index)=>`C${index}`)];
const progress={matterReference:"P261793",templateId:"matter-detail.progress-records.v1",columns:["idx","idx_parent","serial","sourcecode","no_rec","sort"],rows:[{idx:"other-key",idx_parent:"parent-key",serial:"serial-a",sourcecode:"source-a",no_rec:"1",sort:"2"},{idx:"private-progress-key",idx_parent:"parent-key",serial:"serial-b",sourcecode:"source-b",no_rec:"2",sort:"3"}]};

test("links one fixed document predicate to one verified progress row without values",()=>{
  const result=inspectDocumentProgressLinkage({statement,candidate,progressResult:progress,expectedResponseColumns:expected});
  assert.equal(result.matchingPredicateColumn,"GRP_KEY");
  assert.equal(result.matchedProgressRowCount,1);
  assert.equal(result.progressRowsExamined,2);
  assert.doesNotMatch(JSON.stringify(result),/private-progress-key|other-key/);
});

test("reports only field names when document predicates match progress linkage candidates",()=>{
  const evidence=inspectDocumentPredicateEvidence({statement,candidate,progressResult:progress});
  assert.deepEqual(evidence.matches,[{predicateColumn:"GRP_KEY",progressField:"idx",matchingRowCount:1}]);
  assert.doesNotMatch(JSON.stringify(evidence),/private-progress-key|parent-key|serial-a|source-a/);
});

test("broad evidence reports source field names but never compared values",()=>{
  const main={matterReference:"P261793",templateId:"matter-detail.main-record.v1",columns:["idx","division","secret"],rows:[{idx:"main-key",division:"국내",secret:"PRIVATE_BUSINESS_VALUE"}]};
  const evidenceStatement="SELECT * FROM docs WHERE GRP_KEY = 'main-key' AND DIV = '국내'",evidenceCandidate={...candidate,fingerprint:fingerprintEnvelope({templateId:candidate.templateId,command:"SELECT",statements:[evidenceStatement]})};
  const evidence=inspectDocumentBroadPredicateEvidence({statement:evidenceStatement,candidate:evidenceCandidate,mainResult:main,progressResult:progress});
  assert.deepEqual(evidence.matches,[{predicateColumn:"GRP_KEY",sourceRole:"main-record",sourceColumn:"idx",matchingRowCount:1},{predicateColumn:"DIV",sourceRole:"main-record",sourceColumn:"division",matchingRowCount:1}]);
  assert.doesNotMatch(JSON.stringify(evidence),/main-key|PRIVATE_BUSINESS_VALUE|국내/);
});

test("rejects changed SQL, ambiguity, another matter, and non-response predicates",()=>{
  assert.throws(()=>inspectDocumentProgressLinkage({statement:statement.replace("docs","changed"),candidate,progressResult:progress,expectedResponseColumns:expected}),/FINGERPRINT/);
  const duplicate={...progress,rows:[{idx:"private-progress-key"},{idx:"private-progress-key"}]};
  assert.throws(()=>inspectDocumentProgressLinkage({statement,candidate,progressResult:duplicate,expectedResponseColumns:expected}),/PROGRESS_REJECTED/);
  assert.throws(()=>inspectDocumentProgressLinkage({statement,candidate,progressResult:{...progress,matterReference:"P261793-S1"},expectedResponseColumns:expected}),/PROGRESS_REJECTED/);
  const noColumnStatement="SELECT * FROM docs WHERE hidden = 'private-progress-key'",noColumnCandidate={...candidate,fingerprint:fingerprintEnvelope({templateId:candidate.templateId,command:"SELECT",statements:[noColumnStatement]})};
  assert.throws(()=>inspectDocumentProgressLinkage({statement:noColumnStatement,candidate:noColumnCandidate,progressResult:progress,expectedResponseColumns:expected}),/NOT_UNIQUE/);
});
