import {collectLiteralEqualities} from "./matter-linkage.mjs";
import {credentialColumns} from "./response-schema.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

function uniqueLiteral(envelope,column){
  const values=collectLiteralEqualities(envelope?.statements?.[0]??"").filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024||MASK.test(values[0].literal))throw new Error("DOCUMENT_GROUP_SOURCE_TARGET_REJECTED");
  return values[0].literal;
}

function matches(result,value){
  return result.columns.map(column=>({column,matchingRowCount:result.rows.filter(row=>row?.[column]===value).length})).filter(item=>item.matchingRowCount>0);
}

export function inspectDocumentGroupSourceResponse({result,intermediateEnvelope,documentEnvelope,expectedColumns}){
  if(!Array.isArray(expectedColumns)||expectedColumns.length!==55||!Array.isArray(result?.columns)||result.columns.length!==expectedColumns.length||
     !expectedColumns.every((column,index)=>column===result.columns[index])||credentialColumns(result.columns).length||
     !Array.isArray(result.rows)||result.rows.length!==1)throw new Error("DOCUMENT_GROUP_SOURCE_RESPONSE_REJECTED");
  const intermediateIdentity=uniqueLiteral(intermediateEnvelope,"idx"),documentGroup=uniqueLiteral(documentEnvelope,"GRP_KEY");
  const intermediateIdentityCandidateColumns=matches(result,intermediateIdentity),documentGroupCandidateColumns=matches(result,documentGroup);
  const jointRowCount=result.rows.filter(row=>intermediateIdentityCandidateColumns.some(item=>row?.[item.column]===intermediateIdentity)&&documentGroupCandidateColumns.some(item=>row?.[item.column]===documentGroup)).length;
  return Object.freeze({
    status:intermediateIdentityCandidateColumns.length?"document-group-source-response-candidate-found":"document-group-source-response-candidate-not-found",
    sourceSessionId:231,
    responseColumnCount:result.columns.length,
    responseRowCount:result.rows.length,
    intermediateIdentityCandidateColumns:Object.freeze(intermediateIdentityCandidateColumns.map(Object.freeze)),
    documentGroupCandidateColumns:Object.freeze(documentGroupCandidateColumns.map(Object.freeze)),
    jointRowCount,
    rawRowsReturned:false,
    internalValuesReturned:false,
    serverRequestsPerformed:0,
    productionEnabled:false,
  });
}
