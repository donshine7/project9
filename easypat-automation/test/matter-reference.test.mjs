import test from "node:test";
import assert from "node:assert/strict";
import { normalizeExactMatterReference, parseMatterReference } from "../src/protocol/matter-reference.mjs";

test("normalizes supported matter families while preserving every suffix",()=>{
  assert.deepEqual(parseMatterReference(" p261830-s1 "),{
    value:"P261830-S1",prefix:"P",number:"261830",family:"patent",suffixes:["S1"],
  });
  assert.equal(parseMatterReference("pt12345").family,"sangsang-provisional");
  assert.equal(parseMatterReference("ppt12345-cn(pa)").family,"sangsang-plus-provisional");
  assert.equal(parseMatterReference("t12345").family,"trademark");
});

test("keeps CN, CN(PA), and series members as distinct complete identities",()=>{
  const values=["P261793-CN","P261793-CN(PA)","P261793-S1","P261793-S2"].map(normalizeExactMatterReference);
  assert.equal(new Set(values).size,4);
});

test("rejects non-matter tokens and query injection characters",()=>{
  for(const value of ["261793","X261793","P12","P261793' OR 1=1--","P261793 S1","P261793/../X","P261793-","P261793()",null]){
    assert.throws(()=>normalizeExactMatterReference(value),/MATTER_REFERENCE_REJECTED/);
  }
});
