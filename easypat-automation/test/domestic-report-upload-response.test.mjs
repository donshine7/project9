import assert from "node:assert/strict";
import test from "node:test";
import {inspectCapturedDomesticReportUploadResponse,parseDomesticReportUploadResponse} from "../src/protocol/domestic-report-upload-response.mjs";

const response=body=>({status:200,contentType:"text/html;charset=KSC5601",bytes:Buffer.from(body,"ascii")});

test("converts the captured dated server-relative path into the attachment path",()=>{
  const result=parseDomesticReportUploadResponse(response("2026/09/21/20260921_72760312.pdf"),{expectedFileName:"보고서.pdf"});
  assert.equal(result.uploadedFileName,"upload/app_proc/2026/09/21/20260921_72760312.pdf");
  assert.equal(result.relativePathPatternVerified,true);
});

test("accepts the observed empty TXT probe shape only when its extension matches",()=>{
  assert.equal(parseDomesticReportUploadResponse(response("2026/09/21/20260921_72760312.txt"),{expectedFileName:"test.txt"}).relativePathPatternVerified,true);
  assert.throws(()=>parseDomesticReportUploadResponse(response("2026/09/21/20260921_72760312.txt"),{expectedFileName:"보고서.pdf"}));
});

test("rejects traversal, impossible dates, whitespace, alternate media types and oversized bodies",()=>{
  for(const value of ["../20260921_72760312.pdf","2026/02/31/20260231_72760312.pdf","2026/09/21/20260921_72760312.pdf\n"]){
    assert.throws(()=>parseDomesticReportUploadResponse(response(value),{expectedFileName:"보고서.pdf"}));
  }
  assert.throws(()=>parseDomesticReportUploadResponse({...response("2026/09/21/20260921_72760312.pdf"),contentType:"text/plain"},{expectedFileName:"보고서.pdf"}));
  assert.throws(()=>parseDomesticReportUploadResponse(response("a".repeat(513)),{expectedFileName:"보고서.pdf"}));
});

test("inspects the observed Fiddler chunked response without returning its server path",()=>{
  const body="2026/09/21/20260921_72760312.txt",raw=`HTTP/1.1 200 OK\r\nContent-Type: text/html;charset=KSC5601\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`;
  const result=inspectCapturedDomesticReportUploadResponse({raw,expectedFileName:"test.txt"});
  assert.equal(result.chunkedTransferCaptured,true);assert.equal(result.chunkCount,1);assert.equal(result.relativePathPatternVerified,true);assert.equal(result.rawPathReturned,false);assert.doesNotMatch(JSON.stringify(result),/72760312/);
});
