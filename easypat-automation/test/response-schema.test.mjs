import test from "node:test";
import assert from "node:assert/strict";
import { inspectResultsetSchema, inspectMultipartSchemas, credentialColumns } from "../src/protocol/response-schema.mjs";

const header = "id\x01pw\x01mobile_refresh_token\r\nchar\x01binary\x01char\r\n30\x0130\x0130\r\nr\x01r\x01r\r\n";
const body = header + '"PRIVATE_PERSON"\x01"PRIVATE_PASSWORD"\x01"PRIVATE_TOKEN"\r\n';
function fixture(framing = "rfc2046", count = 2) {
  const boundary = "----------fixture";
  const d = framing === "rfc2046" ? "--" + boundary : boundary;
  return {text: Array.from({length: count}, () => d + "\r\nContent-Type: text/resultset\r\n\r\n" + body).join("\r\n") + "\r\n" + d + "--\r\n", contentType: "multipart/mixed; boundary=" + boundary + ";charset=UTF-8", expectedPartCount: count, framing};
}
test("schema inspection returns metadata only, including known sensitive column names", () => {
  const result = inspectResultsetSchema(body);
  assert.deepEqual(result.credentialColumns, ["pw", "mobile_refresh_token"]);
  assert.equal(result.rowValuesParsed, false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});
test("recognizes standard framing and explicit observed Jbori framing separately", () => {
  for (const mode of ["rfc2046", "observed-jbori"]) {
    const result = inspectMultipartSchemas(fixture(mode));
    assert.equal(result.partCount, 2);
    assert.equal(result.authenticationVerified, false);
    assert.equal(result.executable, false);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  }
  const legacy = fixture("observed-jbori");
  delete legacy.framing;
  assert.throws(() => inspectMultipartSchemas(legacy), /MULTIPART_SCHEMA_REJECTED/);
});
test("rejects incomplete, wrong-count, nested, unexpected headers and ambiguous framing", () => {
  const f = fixture();
  for (const change of [
    {expectedPartCount: 1}, {expectedPartCount: 0}, {framing: "guess"},
    {text: f.text.slice(0, -10)}, {text: "preamble\r\n" + f.text},
    {text: f.text + "PRIVATE_TRAILER"},
    {text: f.text.replace("text/resultset", "multipart/mixed")},
    {text: f.text.replace("Content-Type:", "Set-Cookie: PRIVATE_COOKIE\r\nContent-Type:")},
    {contentType: f.contentType + ";boundary=other"},
  ]) assert.throws(() => inspectMultipartSchemas({...f, ...change}), /MULTIPART_SCHEMA_REJECTED/);
});
test("rejects invalid metadata without leaking row values in errors", () => {
  for (const text of [body.replace("id\x01pw", "pw\x01pw"), body.replace("binary", "unknown"), "PRIVATE_VALUE", body.replace("30\x0130", "bad\x0130"), "x".repeat(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => inspectResultsetSchema(text), e => e.message === "SCHEMA_REJECTED");
  }
});
test("row validity and authentication are deliberately not inferred from metadata", () => {
  assert.deepEqual(inspectResultsetSchema(header + "invalid masked row"), inspectResultsetSchema(body));
  assert.deepEqual(credentialColumns(["PW", "Password", "access_token", "api_key", "ourref"]), ["PW", "Password", "access_token", "api_key"]);
});
