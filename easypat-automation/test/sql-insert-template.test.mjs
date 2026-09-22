import assert from "node:assert/strict";
import test from "node:test";
import {decodeSqlStringLiteral,encodeSqlStringLiteral,encodeSqlUnicodeStringLiteral,parseInsertStatement,replaceInsertExpressions} from "../src/protocol/sql-insert-template.mjs";

test("parses and binds a captured INSERT without confusing commas in strings or functions",()=>{
  const parsed=parseInsertStatement("INSERT INTO opms_app_proc (idx_parent,rec_doc,d_noti,d_edit) VALUES ('123','문서, 보고','2026-09-21',GETDATE())",{expectedTable:"opms_app_proc"});
  assert.deepEqual(parsed.columns,["idx_parent","rec_doc","d_noti","d_edit"]);
  assert.equal(decodeSqlStringLiteral("'a''b'"),"a'b");
  assert.equal(decodeSqlStringLiteral("N'a''b'"),"a'b");
  assert.equal(encodeSqlStringLiteral("a'b"),"'a''b'");
  assert.equal(encodeSqlUnicodeStringLiteral("한글.pdf"),"N'한글.pdf'");
  assert.equal(replaceInsertExpressions(parsed,{idx_parent:"'456'",rec_doc:"'의견서 및 보정서 제출 요청'"}),"INSERT INTO opms_app_proc (idx_parent,rec_doc,d_noti,d_edit) VALUES ('456','의견서 및 보정서 제출 요청','2026-09-21',GETDATE())");
});

test("rejects extra statements, duplicate columns and wrong tables",()=>{
  assert.throws(()=>parseInsertStatement("INSERT INTO x (a) VALUES ('1'); DELETE FROM x"));
  assert.throws(()=>parseInsertStatement("INSERT INTO x (a,A) VALUES ('1','2')"));
  assert.throws(()=>parseInsertStatement("INSERT INTO x (a) VALUES ('1')",{expectedTable:"y"}));
});
