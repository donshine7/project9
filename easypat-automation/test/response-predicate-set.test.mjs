import test from "node:test";
import assert from "node:assert/strict";
import { compileResponsePredicateSet, verifyResponsePredicateSet } from "../src/protocol/response-predicate-set.mjs";

const policy={mode:"statement-literals-all-rows",columns:["DELETEFLG","DOC_NUM","DIV","GRP_KEY"]};
const statement="SELECT * FROM docs WHERE DELETEFLG='N' AND DOC_NUM=9 AND DIV='국내진행' AND GRP_KEY='private-group'";

test("verifies all fixed document predicates across every row without returning values",()=>{
  const binding=compileResponsePredicateSet(statement,policy),row={DELETEFLG:"N",DOC_NUM:"9",DIV:"국내진행",GRP_KEY:"private-group",FILE_NAME:"one.pdf"};
  const result=verifyResponsePredicateSet({columns:Object.keys(row),rows:[row,{...row,FILE_NAME:"two.pdf"}]},binding);
  assert.deepEqual(result,{verified:true,responseColumns:["DELETEFLG","DOC_NUM","DIV","GRP_KEY"],rowCount:2,rawValuesIncluded:false});
  assert.doesNotMatch(JSON.stringify(result),/private-group|국내진행/);
});

test("fails closed on changed rows, missing predicates, duplicate columns, and malformed policy",()=>{
  const binding=compileResponsePredicateSet(statement,policy),row={DELETEFLG:"N",DOC_NUM:"9",DIV:"국내진행",GRP_KEY:"private-group"};
  assert.throws(()=>verifyResponsePredicateSet({columns:Object.keys(row),rows:[row,{...row,GRP_KEY:"other"}]},binding),error=>!String(error).includes("private-group")&&!String(error).includes("other"));
  assert.throws(()=>compileResponsePredicateSet("SELECT * FROM docs WHERE DELETEFLG='N'",policy));
  assert.throws(()=>compileResponsePredicateSet(statement,{...policy,columns:["DIV","div"]}));
  assert.throws(()=>verifyResponsePredicateSet({columns:[],rows:[]},binding));
});
