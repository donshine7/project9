import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileAuthenticationBinding, assessLoginIdentity } from "../src/protocol/authentication-binding.mjs";
import { scanAuthenticationSql } from "../src/protocol/authentication-shape.mjs";

// Synthetic constants and credentials. This fixture is not a production request.
const fixture = "SELECT T1.*, M1.macad, M1.pcname FROM opms_login_member T1 LEFT JOIN (SELECT TOP 1 userid, macad, pcname FROM opms_login_macads WHERE userid='fixture_user' ORDER BY r_date DESC) M1 ON M1.userid=T1.id WHERE T1.del_flag='N' AND T1.d_retire IS NULL AND T1.ck_off='N' AND T1.div_use='Y' AND T1.id='fixture_user' AND T1.pw=dbo.EncryptTxt('fixture_password')";
test("binds only three observed input slots and preserves fixed constants", () => {
  const compiled=compileAuthenticationBinding(fixture);
  const result=compiled.bind({username:"new_user",password:"new_password"});
  const a=scanAuthenticationSql(fixture), b=scanAuthenticationSql(result);
  for (const slot of [0,2,3,4]) assert.equal(a.literalSpans[slot].raw,b.literalSpans[slot].raw);
  assert.ok(!result.includes("fixture_user") && !result.includes("fixture_password"));
  assert.equal(b.literalSpans[1].raw,"'new_user'");
  assert.equal(b.literalSpans[5].raw,"'new_user'");
  assert.equal(b.literalSpans[6].raw,"'new_password'");
  assert.equal(compiled.summary.executable,false);
  assert.ok(!JSON.stringify(compiled).includes("fixture_"));
});
test("quotes and SQL-like credentials stay inside their original string slots", () => {
  const compiled=compileAuthenticationBinding(fixture);
  for (const password of ["a'b", "'); DROP TABLE users;--", "/* literal */", '"double"', "x\\y", "!%&+=?"]) {
    const sql=compiled.bind({username:"o'brien",password});
    const scan=scanAuthenticationSql(sql);
    assert.equal(scan.commentCount,0);
    assert.equal(scan.literalCount,7);
    assert.equal(scan.literalSpans[6].raw,"'"+password.replaceAll("'","''")+"'");
  }
});
test("rejects changed structure, extra statements, comments, mismatched users and unsupported constants", () => {
  for (const sql of [fixture+"; SELECT 1",fixture+" -- comment",fixture.replace("T1.pw=","T1.pw<>"),fixture.replace("dbo.EncryptTxt","dbo.Other"),fixture.replace("userid='fixture_user'","userid='another_user'"),fixture.replace("TOP 1","TOP 0"),fixture.replace("del_flag='N'","del_flag=0")]) {
    assert.throws(()=>compileAuthenticationBinding(sql), e=>e.message==="AUTH_TEMPLATE_REJECTED");
  }
});
test("rejects empty, oversized, control, Unicode and unexpected credential inputs without echoing values", () => {
  const compiled=compileAuthenticationBinding(fixture);
  for (const input of [{username:"",password:"PRIVATE"},{username:"u",password:"PRIVATE\n"},{username:"사용자",password:"PRIVATE"},{username:"u",password:"p".repeat(257)},{username:"u",password:"PRIVATE",sql:"SELECT 1"}]) {
    assert.throws(()=>compiled.bind(input), e=>e.message==="AUTH_BINDING_REJECTED");
  }
});
test("retains captured Unicode literal prefix without changing value encoding", () => {
  const c=compileAuthenticationBinding(fixture.replaceAll("'fixture_user'","N'fixture_user'").replace("'fixture_password'","N'fixture_password'"));
  assert.equal(scanAuthenticationSql(c.bind({username:"new_user",password:"new_pass"})).literalSpans[6].raw,"N'new_pass'");
});
test("projected user identity evidence cannot declare authentication or release a session", () => {
  for (const [ids, status] of [[[],"no-matching-user-row"],[["u"],"identity-row-matched"],[["other"],"identity-row-mismatched"],[["u","u"],"ambiguous-user-rows"]]) {
    const r=assessLoginIdentity({ids,schemaMatched:true},"u");
    assert.equal(r.status,status); assert.equal(r.authenticationVerified,false); assert.equal(r.sessionMayBeIssued,false);
    assert.ok(!JSON.stringify(r).includes('"other"'));
  }
  assert.equal(assessLoginIdentity({ids:["u"],schemaMatched:false},"u").status,"unverified-response");
});
test("offline binding CLI verifies replacements without exposing original or replacement credentials", () => {
  const cli=fileURLToPath(new URL('../src/inspect-auth-shape.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[cli,'binding'],{input:fixture,encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0);
  const summary=JSON.parse(r.stdout);
  assert.equal(summary.replacementRoundTripVerified,true);
  assert.equal(summary.valuesIncluded,false);
  for (const value of ['fixture_user','fixture_password','offline_binding_probe','offline_probe_']) assert.ok(!(r.stdout+r.stderr).includes(value));
});
