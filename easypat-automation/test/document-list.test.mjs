import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseDocumentListEvidence, inspectDocumentListEvidence, projectDocumentList, resolveDocumentDownload } from "../src/protocol/document-list.mjs";

function source(overrides={}){const row={IDX:"PRIVATE_IDX",GRP_KEY:"PRIVATE_GROUP",DOC_NUM:"9",DIV:"국내진행",DELETEFLG:"N",DOC_NAME:"중간서류",REG_DATE:"2026-05-21",FILE_NAME:"P261793외_수임내역서.pdf",FILE_NAME_UPLOAD:"upload/app_proc/2026/05/21/20260521_12345678.pdf",FILE_SIZE:"51373",MUID:"PRIVATE_USER",...overrides};return{matterReference:"P261793",templateId:"matter-detail.documents.v1",columns:Object.keys(row),rows:[row]};}

test("validates path, size, type, and matter filename evidence without returning paths",()=>{
  const evidence=inspectDocumentListEvidence(source());
  assert.equal(evidence.rowCount,1);assert.equal(evidence.matterFilenameEvidenceCount,1);
  assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE|upload\/|수임내역서/);
});

test("projects only user-facing document metadata",()=>{
  const list=projectDocumentList(source());
  assert.deepEqual(list.items[0],{position:1,documentName:"중간서류",registeredAt:"2026-05-21",fileName:"P261793외_수임내역서.pdf",fileSizeBytes:51373});
  assert.doesNotMatch(JSON.stringify(list),/PRIVATE|FILE_NAME_UPLOAD|upload\/app_proc/);
});

test("rejects another matter, traversal, mismatched types, oversized files, controls, and missing matter evidence",()=>{
  assert.throws(()=>inspectDocumentListEvidence({...source(),matterReference:"P261793-S1"}),/SOURCE_REJECTED/);
  for(const row of [{FILE_NAME_UPLOAD:"upload/app_proc/2026/05/21/../secret.pdf"},{FILE_NAME_UPLOAD:"upload/app_proc/2026/05/21/file.jpg"},{FILE_SIZE:String(65*1024*1024)},{FILE_NAME:"bad\nP261793.pdf"},{FILE_NAME:"unrelated.pdf"}])assert.throws(()=>inspectDocumentListEvidence(source(row)));
});

test("requires an explicit trusted context binding when shared-group filenames omit P261793",()=>{
  const shared=source({FILE_NAME:"shared-group.pdf"});
  assert.throws(()=>projectDocumentList(shared),/MATTER_EVIDENCE_REJECTED/);
  const list=projectDocumentList(shared,{contextBinding:"captured-p261793-fixed-document-group"});
  assert.equal(list.count,1);
  assert.throws(()=>projectDocumentList(shared,{contextBinding:"caller-supplied"}),/MATTER_EVIDENCE_REJECTED/);
});

test("diagnostics return only category counts",()=>{
  const diagnostic=diagnoseDocumentListEvidence(source({FILE_NAME:"unrelated.exe",FILE_NAME_UPLOAD:"bad/path.exe",FILE_SIZE:"not-a-size"}));
  assert.deepEqual({invalidUploadPath:diagnostic.invalidUploadPath,unsupportedFileType:diagnostic.unsupportedFileType,invalidFileSize:diagnostic.invalidFileSize,matterFilenameEvidence:diagnostic.matterFilenameEvidence},{invalidUploadPath:1,unsupportedFileType:1,invalidFileSize:1,matterFilenameEvidence:0});
  assert.doesNotMatch(JSON.stringify(diagnostic),/unrelated|bad\/path|not-a-size|PRIVATE/);
});

test("resolves a download path only from an exact list position and filename",()=>{const target=resolveDocumentDownload(source(),{position:1,expectedFileName:"P261793외_수임내역서.pdf"});assert.equal(target.uploadPath,"upload/app_proc/2026/05/21/20260521_12345678.pdf");assert.throws(()=>resolveDocumentDownload(source(),{position:1,expectedFileName:"other.pdf"}),/SELECTION_REJECTED/);assert.throws(()=>resolveDocumentDownload(source(),{position:2,expectedFileName:"P261793외_수임내역서.pdf"}),/SELECTION_REJECTED/);});
