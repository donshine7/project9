import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const searchCli = fileURLToPath(new URL("../src/inspect-search-result.mjs", import.meta.url));
const detailCli = fileURLToPath(new URL("../src/inspect-detail-keys.mjs", import.meta.url));
const prefix = "idx\x01ourref\r\nbigint\x01char\r\n0\x0120\r\nr\x01r\r\n";
test("search CLI produces a comparable digest without emitting its identifier", () => {
  const value = "9007199254740993";
  const result = spawnSync(process.execPath,[searchCli],{input:prefix+value+'\x01"P261793"\r\n',encoding:"utf8",timeout:5000});
  assert.equal(result.status,0);
  const output=JSON.parse(result.stdout);
  assert.equal(output.valueDigest,createHash("sha256").update(value).digest("hex"));
  assert.equal(output.exactReference,true);
  assert.equal(output.executable,false);
  assert.ok(!result.stdout.includes(value));
});
test("CLI rejects wrong reference and changed detail captures without leaking input", () => {
  const wrong=spawnSync(process.execPath,[searchCli],{input:prefix+'99\x01"P261793-S1"',encoding:"utf8",timeout:5000});
  assert.equal(wrong.status,1);
  const changed=spawnSync(process.execPath,[detailCli,"168"],{input:"SELECT 'private-detail-marker'",encoding:"utf8",timeout:5000});
  assert.equal(changed.status,1);
  assert.doesNotMatch(changed.stdout+changed.stderr,/private-detail-marker/);
});
