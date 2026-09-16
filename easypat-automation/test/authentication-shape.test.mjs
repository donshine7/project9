import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectAuthenticationSql, inspectCookieShape } from "../src/protocol/authentication-shape.mjs";
test("authentication SQL shape hides string, binary, numeric and comment values", () => {
  const r = inspectAuthenticationSql("SELECT [pw] FROM users WHERE id=N'private-user' AND pw=HASHBYTES('algo','private''password') AND code=0xABCD AND n=1234 -- private-comment\n/* private-block */");
  assert.equal(r.valuesIncluded,false);
  assert.equal(r.executable,false);
  assert.match(r.shape,/HASHBYTES/);
  for (const v of ['private','ABCD','1234','algo']) assert.ok(!r.shape.includes(v));
});
test("unsupported or masked SQL fails without echoing source", () => {
  for (const s of ["UPDATE users SET pw='private'", "SELECT 'unfinished", "SELECT !!!sanitized!!!", "SELECT @private", "SELECT /* nested /* private */ */ 1"]) {
    assert.throws(()=>inspectAuthenticationSql(s), e=>e.message==='AUTH_SHAPE_REJECTED');
  }
});
test("cookie shape exposes only name and scope attributes", () => {
  const r = inspectCookieShape("Set-Cookie: JSESSIONID=private-value; Path=/; Secure; HttpOnly; SameSite=Lax");
  assert.equal(r.name,"JSESSIONID");
  assert.ok(!JSON.stringify(r).includes("private-value"));
  for (const s of ["sid=private\r\nX:bad","!!!sanitized!!!","sid=private; unknown=private"]) assert.throws(()=>inspectCookieShape(s));
});
test("cookie inspection accepts copied row syntax and rejects duplicate or malformed attributes", () => {
  assert.equal(inspectCookieShape("Set-Cookie\tsid=PRIVATE; Path=/app\r\n").name,"sid");
  for (const s of ["sid=PRIVATE; Secure=x", "sid=PRIVATE; Path=/; path=/app", "sid=PRIVATE; SameSite=private", "sid=PRIVATE; Max-Age=private", "sid=PRIVATE; Path=/app?token=PRIVATE"]) assert.throws(()=>inspectCookieShape(s));
});
test("CLI uses private stdin and emits only sanitized output or generic failure", () => {
  const cli = fileURLToPath(new URL('../src/inspect-auth-shape.mjs',import.meta.url));
  for (const [mode, input, success] of [
    ['sql', "SELECT id FROM users WHERE pw=dbo.EncryptTxt('PRIVATE_VALUE')", true],
    ['cookie', 'sid=PRIVATE_VALUE; Path=/; HttpOnly', true],
    ['sql', "SELECT 'PRIVATE_VALUE", false],
  ]) {
    const r=spawnSync(process.execPath,[cli,mode],{input,encoding:'utf8',windowsHide:true});
    assert.equal(r.status,success?0:1);
    assert.ok(!(r.stdout+r.stderr).includes('PRIVATE_VALUE'));
    assert.equal(JSON.parse(success?r.stdout:r.stderr).executable,false);
  }
});
