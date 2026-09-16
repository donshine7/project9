import test from "node:test";
import assert from "node:assert/strict";
import {
  compilePredicateResponseIdentity,
  verifyPredicateResponseIdentity,
} from "../src/protocol/response-identity.mjs";

const verification = {
  mode: "statement-literal-equality",
  predicateColumn: "idx",
  responseColumn: "idx",
};

test("binds one fixed predicate to one response row without returning the internal value", () => {
  const binding = compilePredicateResponseIdentity("SELECT * FROM example WHERE idx = 'private-key'", verification);
  const result = verifyPredicateResponseIdentity({columns:["idx", "ourref"],rows:[{idx:"private-key",ourref:"different-display-reference"}]},binding);
  assert.deepEqual(result,{verified:true,responseColumn:"idx",rowCount:1,rawIdentityIncluded:false});
  assert.doesNotMatch(JSON.stringify(result),/private-key/);
});

test("requires every progress row to match the fixed parent identity", () => {
  const progressVerification={mode:"statement-literal-all-rows",predicateColumn:"idx_parent",responseColumn:"idx_parent"};
  const binding=compilePredicateResponseIdentity("SELECT * FROM progress WHERE idx_parent='private-key'",progressVerification);
  const valid={columns:["idx_parent","memo"],rows:[{idx_parent:"private-key",memo:"a"},{idx_parent:"private-key",memo:"b"}]};
  assert.equal(verifyPredicateResponseIdentity(valid,binding).rowCount,2);
  assert.throws(()=>verifyPredicateResponseIdentity({...valid,rows:[...valid.rows,{idx_parent:"other-key",memo:"c"}]},binding),error=>!String(error).includes("key"));
  assert.throws(()=>verifyPredicateResponseIdentity({...valid,rows:[]},binding));
});

test("fails closed for a changed response, duplicate predicate, or malformed policy without exposing values", () => {
  const binding = compilePredicateResponseIdentity("SELECT * FROM example WHERE idx = 'private-key'", verification);
  assert.throws(
    () => verifyPredicateResponseIdentity({columns:["idx"],rows:[{idx:"other-private-key"}]},binding),
    error => !String(error).includes("private-key") && !String(error).includes("other-private-key"),
  );
  assert.throws(
    () => compilePredicateResponseIdentity("SELECT * FROM example WHERE idx='a' OR idx='b'",verification),
    error => !String(error).includes("'a'") && !String(error).includes("'b'"),
  );
  assert.throws(() => compilePredicateResponseIdentity("SELECT 1",{...verification,responseColumn:"idx;drop"}));
});
