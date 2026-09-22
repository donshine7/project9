import assert from "node:assert/strict";
import test from "node:test";
import {inspectDomesticReportUploadCapture} from "../src/protocol/domestic-report-upload-capture.mjs";

function raw(body,contentType="application/x-www-form-urlencoded; charset=utf-8",endpoint="https://mssql2.easypnp.co.kr:8443/servlet/Jbori"){
  return `POST ${endpoint} HTTP/1.1\nContent-type: ${contentType}\nContent-length: ${Buffer.byteLength(body)}\nCookie: JSESSIONID=secret\n\n${body}`;
}

test("captures an encrypted-template candidate for the fixed attachment INSERT shape",()=>{
  const sql="INSERT INTO opms_attach (DIV,GRP_KEY,DOC_NUM,DOC_NAME,REG_DATE,USR_DATE,FILE_NAME,FILE_NAME_UPLOAD,FILE_SIZE,MEMO,DOWN_COUNT,CK_OPEN,MUID,MUNAME) VALUES ('app_proc','1','2','문서',GETDATE(),GETDATE(),'server','보고서.pdf','10','','0','Y','3','장진태')";
  const result=inspectDomesticReportUploadCapture({kind:"attach-insert",raw:raw(new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"INSERT",sql}).toString())});
  assert.equal(result.envelope.templateId,"matter-progress.attach-insert.v1");
  assert.deepEqual(result.statementTables,["opms_attach"]);
  assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
});

test("captures the four-statement progress/history write batch only",()=>{
  const statements=["INSERT INTO opms_history (A) VALUES ('1')","INSERT INTO opms_history (A) VALUES ('2')","INSERT INTO opms_history (A) VALUES ('3')","INSERT INTO opms_history (A) VALUES ('4')"];
  const result=inspectDomesticReportUploadCapture({kind:"history-batch",raw:raw(new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"4",command:"OTHERS",...Object.fromEntries(statements.map((value,index)=>[`sql${index}`,value]))}).toString())});
  assert.deepEqual(result.statementTables,["opms_history","opms_history","opms_history","opms_history"]);
});

test("captures the progress INSERT and generated identity batch",()=>{
  const statements=["INSERT INTO opms_app_proc (idx_parent,doc) VALUES ('1','특허 출원 진행 요청')","SELECT scope_identity() AS idx"];
  const result=inspectDomesticReportUploadCapture({kind:"progress-insert-batch",raw:raw(new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"2",command:"OTHERS",sql0:statements[0],sql1:statements[1]}).toString())});
  assert.deepEqual(result.statementTables,["opms_app_proc","scope_identity"]);
});

test("captures only the two fixed read-back table families",()=>{
  for(const [kind,table] of [["progress-readback","opms_app_proc"],["attachment-readback","opms_attach"]]){
    const sql=`SELECT * FROM ${table} WHERE idx_parent = '31883'`,result=inspectDomesticReportUploadCapture({kind,raw:raw(new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql}).toString())});
    assert.equal(result.definition.command,"SELECT");assert.deepEqual(result.statementTables,[null]);assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
  }
  const wrong=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:"SELECT * FROM users"}).toString();
  assert.throws(()=>inspectDomesticReportUploadCapture({kind:"progress-readback",raw:raw(wrong)}));
});

test("captures only the multipart upload shape and not the selected file name or bytes",()=>{
  const boundary="----------------capture-boundary",body=[`--${boundary}`,'Content-Disposition: form-data; name="connection"','',"EASYPAT_S_SSPAT_app_proc",`--${boundary}`,'Content-Disposition: form-data; name="command"','',"upload",`--${boundary}`,'Content-Disposition: form-data; name="file"; filename="test.txt"',"Content-Type: text/plain","","",`--${boundary}--`,""].join("\n");
  const result=inspectDomesticReportUploadCapture({kind:"file-transfer",raw:raw(body,`multipart/form-data; boundary=${boundary}`,"https://mssql2.easypnp.co.kr:8443/servlet/UploadExecute")});
  assert.deepEqual(result.fieldOrder,["connection","command","file"]);
  assert.equal(result.filePartName,"file");
  assert.equal(result.filePartContentType,"text/plain");
  assert.doesNotMatch(JSON.stringify(result),/test\.txt|JSESSIONID|secret/);
});

test("rejects alternate endpoints, extra form fields and arbitrary write tables",()=>{
  const valid=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"INSERT",sql:"INSERT INTO opms_attach (A) VALUES ('1')"}).toString();
  assert.throws(()=>inspectDomesticReportUploadCapture({kind:"attach-insert",raw:raw(valid).replace("/servlet/Jbori","/other")}));
  assert.throws(()=>inspectDomesticReportUploadCapture({kind:"attach-insert",raw:raw(valid+"&extra=1")}));
  assert.throws(()=>inspectDomesticReportUploadCapture({kind:"attach-insert",raw:raw(valid.replace("opms_attach","users"))}));
});
