import { collectLiteralEqualities } from "./matter-linkage.mjs";

const NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

export function compileResponsePredicateSet(statement,verification){
  if(!verification||Object.keys(verification).sort().join(",")!=="columns,mode"||verification.mode!=="statement-literals-all-rows"||
     !Array.isArray(verification.columns)||verification.columns.length<1||verification.columns.length>16||
     verification.columns.some(column=>!NAME.test(column))||new Set(verification.columns.map(column=>column.toLowerCase())).size!==verification.columns.length){
    throw new Error("invalid response predicate-set policy");
  }
  const predicates=collectLiteralEqualities(statement),bindings=[];
  for(const column of verification.columns){
    const matches=predicates.filter(item=>item.column.toLowerCase()===column.toLowerCase());
    if(matches.length!==1||typeof matches[0].literal!=="string"||!matches[0].literal.length||matches[0].literal.length>1024||MASK.test(matches[0].literal))throw new Error("fixed statement predicate-set mismatch");
    bindings.push({predicateColumn:column,responseColumn:column,expectedValue:matches[0].literal});
  }
  return Object.freeze({mode:verification.mode,bindings:Object.freeze(bindings)});
}

export function verifyResponsePredicateSet(result,binding){
  if(!result||!Array.isArray(result.columns)||!Array.isArray(result.rows)||result.rows.length<1||binding?.mode!=="statement-literals-all-rows"||!Array.isArray(binding.bindings)||!binding.bindings.length)throw new Error("response predicate-set mismatch");
  const verifiedColumns=[];
  for(const item of binding.bindings){
    const matches=result.columns.filter(column=>column.toLowerCase()===item.responseColumn.toLowerCase());
    if(matches.length!==1||result.rows.some(row=>row?.[matches[0]]!==item.expectedValue))throw new Error("response predicate-set mismatch");
    verifiedColumns.push(matches[0]);
  }
  return Object.freeze({verified:true,responseColumns:Object.freeze(verifiedColumns),rowCount:result.rows.length,rawValuesIncluded:false});
}
