import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const script=readFileSync(new URL("../scripts/Register-EasyPatCredential.ps1",import.meta.url),"utf8");

test("credential registration uses a secure prompt and refuses replacement",()=>{
  assert.match(script,/Read-Host 'EasyPAT password' -AsSecureString/);
  assert.match(script,/CredWriteW/);
  assert.match(script,/will not overwrite/);
  assert.match(script,/SecureStringToBSTR/);
  assert.match(script,/ZeroFreeBSTR/);
  assert.doesNotMatch(script,/cmdkey|\/pass:|ConvertFrom-SecureString/i);
});
