import test from "node:test";
import assert from "node:assert/strict";
import {diagnoseCopiedSqlInput,normalizeCopiedSqlInput} from "../src/protocol/copied-sql-input.mjs";

test("accepts raw SQL, a Fiddler name/value row, and an exact URL-encoded SELECT form",()=>{
  assert.equal(normalizeCopiedSqlInput(" SELECT * FROM safe WHERE id='one' ").inputFormat,"raw-sql-value");
  assert.equal(normalizeCopiedSqlInput("SELECT*FROM safe WHERE id='one'").inputFormat,"raw-sql-value");
  assert.equal(normalizeCopiedSqlInput("sql\tSELECT * FROM safe WHERE id='one'").inputFormat,"fiddler-name-value-row");
  assert.equal(normalizeCopiedSqlInput("connection=EASYPAT_S_SSPAT&count=1&command=SELECT&sql=SELECT+*+FROM+safe").inputFormat,"urlencoded-form");
  assert.equal(normalizeCopiedSqlInput('"SELECT * FROM safe"').inputFormat,"quoted-json-string");
  assert.equal(normalizeCopiedSqlInput("sql: SELECT * FROM safe").inputFormat,"labelled-sql-value");
  assert.equal(normalizeCopiedSqlInput("SELECT%20*%20FROM%20safe").inputFormat,"percent-encoded-sql-value");
});

test("rejects shell snippets and unknown prefixes instead of extracting a read keyword",()=>{
  for(const value of ["SELECT|WITH)\\s'", "$v.TrimStart() -match '^(SELECT|WITH)\\s'", "Value copied by inspector: SELECT * FROM safe", "echo SELECT * FROM safe", '"SELECT|WITH)\\\\s\'"', "sql: SELECT|WITH)\\s'", "command=SELECT&sql=SELECT%7CWITH%29%5Cs%27"]){
    assert.throws(()=>normalizeCopiedSqlInput(value));
    assert.equal(diagnoseCopiedSqlInput(value).accepted,false);
  }
});

test("diagnostic reports only safe clipboard shape counters and UI classifications",()=>{
  const value=diagnoseCopiedSqlInput("Overview\nHTTP Inspector\nForm-Data");
  assert.equal(value.accepted,false);assert.equal(value.looksLikeFiddlerInterface,true);assert.equal(value.lineFeedCount,2);assert.equal(value.rawValueReturned,false);
  assert.doesNotMatch(JSON.stringify(value),/Overview|Inspector|Form-Data/);
});

test("rejects responses, writes, masks, credential-bearing forms, and non-SQL clipboard text",()=>{
  for(const value of ["IDX\u0001NAME\r\nvalue\u0001value","UPDATE safe SET x=1","SELECT * FROM !!!sanitized!!!","command=SELECT&sql=SELECT+*+FROM+safe&password=secret","password secret SELECT * FROM safe","UPDATE safe SET x=1; SELECT * FROM safe","sql","<html>login</html>"]){assert.throws(()=>normalizeCopiedSqlInput(value));}
  const diagnostic=diagnoseCopiedSqlInput("IDX\u0001NAME\r\nvalue\u0001value");assert.equal(diagnostic.accepted,false);assert.equal(diagnostic.looksLikeResultset,true);assert.equal(diagnostic.rawValueReturned,false);
});
