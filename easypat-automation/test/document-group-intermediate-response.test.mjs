import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {normalizeCopiedResultsetInput,diagnoseCopiedResultsetInput} from "../src/protocol/copied-resultset-input.mjs";
import {diagnoseDocumentRequest} from "../src/protocol/document-request-diagnostic.mjs";
import {inspectDocumentGroupIntermediateResponse} from "../src/protocol/document-group-intermediate-response.mjs";
import {DOCUMENT_GROUP_CAPTURE} from "../src/protocol/document-group-capture-version.mjs";

const mainEnvelope={templateId:"matter-detail.main-record.v1",command:"SELECT",statements:["SELECT * FROM matters WHERE idx='matter-101'"]},documentEnvelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT * FROM docs WHERE GRP_KEY='group-202'"]};
const wire="idx_parent\x01group_id\x01label\r\nchar\x01char\x01char\r\n64\x0164\x01100\r\nwn\x01wn\x01wn\r\n\"matter-101\"\x01\"group-202\"\x01\"safe\"\r\n";

test("normalizes and links a captured intermediate response without returning values",()=>{
  const normalized=normalizeCopiedResultsetInput(wire),value=inspectDocumentGroupIntermediateResponse({result:normalized.result,mainEnvelope,documentEnvelope});
  assert.deepEqual(value.matterIdentityCandidateColumns,[{column:"idx_parent",matchingRowCount:1}]);assert.deepEqual(value.documentGroupCandidateColumns,[{column:"group_id",matchingRowCount:1}]);assert.equal(value.jointRowCount,1);assert.doesNotMatch(JSON.stringify(value),/matter-101|group-202/);
});

test("accepts an HTTP raw body and rejects credential columns",()=>{
  assert.equal(normalizeCopiedResultsetInput("HTTP/1.1 200 OK\r\nContent-Type: text/resultset\r\n\r\n"+wire).inputFormat,"http-raw-body");
  const bad=normalizeCopiedResultsetInput(wire.replace("label","password"));assert.throws(()=>inspectDocumentGroupIntermediateResponse({result:bad.result,mainEnvelope,documentEnvelope}),/DOCUMENT_GROUP_RESPONSE_REJECTED/);
});

test("handles one PowerShell-added newline while preserving quoted multiline values",()=>{
  const multiline=wire.replace('"safe"','"line1\r\nline2\r\n"');
  for(const ending of ["\r\n","\n"]){
    const parsed=normalizeCopiedResultsetInput(multiline+ending);
    assert.equal(parsed.pipelineNewlineRemoved,true);
    assert.deepEqual(parsed.result,normalizeCopiedResultsetInput(multiline).result);
    assert.equal(parsed.result.rows[0].label,"line1\r\nline2\r\n");
  }
  assert.equal(normalizeCopiedResultsetInput(wire).pipelineNewlineRemoved,false);
  assert.throws(()=>normalizeCopiedResultsetInput(wire+"\r\n\r\n"));
  assert.throws(()=>normalizeCopiedResultsetInput(wire.replace('"safe"','"unfinished')+"\r\n"));
});

test("reports parse failure classes without exposing any copied values",()=>{
  const shell=diagnoseCopiedResultsetInput('$r = Get-Clipboard -Raw\r\n$r | & "private-user-path/node.exe"');
  assert.equal(shell.failureCode,"SHELL_COMMAND_TEXT");
  assert.equal(diagnoseCopiedResultsetInput(wire.replaceAll("\x01","\t")).failureCode,"RESULTSET_SEPARATOR_MISSING");
  const expected=diagnoseCopiedResultsetInput(wire+"\r\n");
  assert.equal(expected.accepted,true);assert.equal(expected.strictParseCode,"FIELD_COUNT_MISMATCH");assert.equal(expected.pipelineNewlineRemoved,true);
  for(const value of [shell,expected,diagnoseCopiedResultsetInput(wire.replace('"safe"','"unclosed'))]){
    assert.doesNotMatch(JSON.stringify(value),/private-user-path|matter-101|group-202|idx_parent|unclosed/);
  }
});

test("does not silently skip unknown leading records or a non-200 HTTP wrapper",()=>{
  assert.throws(()=>normalizeCopiedResultsetInput("unrelated private prefix\r\n"+wire));
  assert.throws(()=>normalizeCopiedResultsetInput("HTTP/1.1 401 Unauthorized\r\nContent-Type: text/resultset\r\n\r\n"+wire));
});

test("a copied SELECT/WITH regex is not SQL request evidence",()=>{
  const diagnostic=diagnoseDocumentRequest("SELECT|WITH)\\s'");
  assert.equal(diagnostic.shellSyntaxDetected,true);assert.equal(diagnostic.fromClauseObserved,false);
  assert.equal(diagnostic.predicateInspectionSupported,false);
  const sql=diagnoseDocumentRequest("SELECT * FROM opms_app_proc WHERE idx_parent='private' ");
  assert.equal(sql.shellSyntaxDetected,false);assert.equal(sql.fromClauseObserved,true);assert.equal(sql.predicateInspectionSupported,true);
});

test("CLI classifies bad response before touching encrypted templates",()=>{
  const proc=spawnSync(process.execPath,[fileURLToPath(new URL("../src/inspect-document-group-intermediate-response.mjs",import.meta.url))],{
    input:'$r = Get-Clipboard -Raw\n$r | & "private-command.mjs"',encoding:"utf8",
  });
  assert.equal(proc.status,1);
  const output=JSON.parse(proc.stderr);
  assert.equal(output.failureStage,"parse-response");
  assert.equal(output.inputDiagnostic.failureCode,"SHELL_COMMAND_TEXT");
  assert.equal(output.serverRequestsPerformed,0);
  assert.equal(output.rawValuesReturned,false);
  assert.doesNotMatch(proc.stdout+proc.stderr,/private-command|Get-Clipboard/);
});

test("replacement captures use a new identity and leave legacy evidence untouched",()=>{
  assert.equal(DOCUMENT_GROUP_CAPTURE.schemaVersion,2);
  assert.equal(DOCUMENT_GROUP_CAPTURE.templateId,"matter-detail.document-group-intermediate.v2");
  assert.equal(DOCUMENT_GROUP_CAPTURE.requestMetadataFile,"document-group-intermediate-request.v2.json");
});
