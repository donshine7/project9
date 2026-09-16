import assert from "node:assert/strict";
import test from "node:test";
import {extractTextFacts} from "../src/extraction/text-facts.mjs";

test("extracts bounded matter, amount, keyword, and masking facts",()=>{
  const facts=extractTextFacts("P261793 특허 수임\n메이킹 550-220\n비용 100+10\nXXXX 사건");
  assert.deepEqual(facts.matterReferences,["P261793"]);
  assert.deepEqual(facts.amountExpressions,["550-220","100+10"]);
  assert.deepEqual(facts.keywordHits,["수임","특허","메이킹"]);
  assert.equal(facts.maskedTokenCount,1);
  assert.equal(facts.lineCount,4);
});

test("rejects unbounded OCR text",()=>assert.throws(()=>extractTextFacts("x".repeat(100001)),/OCR_TEXT_REJECTED/));

test("normalizes OCR spaces inside amount expressions",()=>{
  assert.deepEqual(extractTextFacts("변리사 550-1 10\n연구전담부서 100+ 10").amountExpressions,["550-110","100+10"]);
});
