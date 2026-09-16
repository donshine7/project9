import test from "node:test";
import assert from "node:assert/strict";
import { parseResultset } from "../src/protocol/resultset.mjs";
const header = "idx\x01ourref\x01note\r\nbigint\x01char\x01char\r\n0\x0150\x01100\r\nr\x01r\x01r\r\n";
test("parses observed resultset framing and preserves large integer keys", () => {
  const result = parseResultset(header + '9007199254740993\x01"P261793"\x01null\r\n');
  assert.deepEqual(result.rows, [{idx:"9007199254740993",ourref:"P261793",note:null}]);
});
test("quoted separators, multiline text, escaped quotes and quoted null retain meaning", () => {
  const result = parseResultset(header + '12\x01"P261793"\x01"a\x01b\r\nc""d"\r\n13\x01"P261793-S1"\x01"null"\r\n');
  assert.equal(result.rows[0].note, 'a\x01b\r\nc"d');
  assert.equal(result.rows[1].note, "null");
});
test("fails closed for masked data, wrong widths and incomplete quoting", () => {
  for (const row of ['!!!sanitized!!!\x01"P261793"\x01null', '12\x01"P261793"', '12\x01"P261793"\x01"unfinished']) {
    assert.throws(()=>parseResultset(header+row));
  }
  assert.throws(()=>parseResultset(header.replace("ourref", "idx")));
});

test("accepts observed Korean column names and timestamp metadata only within identifier bounds", () => {
  const text='idx\x01우선권주장일\r\nchar\x01timestamp\r\n20\x018\r\nr\x01r\r\n"1"\x01"20260915"\r\n';
  const result=parseResultset(text);
  assert.deepEqual(result.columns,["idx","우선권주장일"]);
  assert.equal(result.types[1],"timestamp");
  for(const name of ["bad name","bad.name","💥","a\u0000b","a".repeat(129)]){
    assert.throws(()=>parseResultset(text.replace("우선권주장일",name)),/invalid resultset columns/);
  }
});
