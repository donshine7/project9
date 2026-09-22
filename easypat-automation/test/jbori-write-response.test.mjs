import assert from "node:assert/strict";
import test from "node:test";
import {parseHistoryAcknowledgements,parseIntegerAcknowledgement,parseProgressIdentityResponse} from "../src/protocol/jbori-write-response.mjs";
const rs="idx\r\nbigint\r\n20\r\nr\r\n\"171151\"\r\n";
const multipart=parts=>{const boundary="----------fixture";return{contentType:`multipart/mixed; boundary=${boundary};charset=UTF-8`,bytes:Buffer.from(parts.map(({type,body})=>`${boundary}\r\nContent-Type: ${type}\r\n\r\n${body}`).join("\r\n")+`\r\n${boundary}--\r\n`)}};
test("parses the generated progress identity only after an acknowledged insert",()=>{assert.equal(parseProgressIdentityResponse(multipart([{type:"text/integer",body:"1"},{type:"text/resultset",body:rs}])),"171151");});
test("requires every history insert and single insert to acknowledge exactly one row",()=>{assert.equal(parseHistoryAcknowledgements(multipart(Array.from({length:4},()=>({type:"text/integer",body:"1"})))),4);assert.equal(parseIntegerAcknowledgement({contentType:"text/integer;charset=UTF-8",bytes:Buffer.from("1")}),1);assert.throws(()=>parseIntegerAcknowledgement({contentType:"text/integer",bytes:Buffer.from("0")}));});
