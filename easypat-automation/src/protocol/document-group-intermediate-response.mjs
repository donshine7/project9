import {collectLiteralEqualities} from "./matter-linkage.mjs";
import {credentialColumns} from "./response-schema.mjs";

function uniqueValue(envelope,column){
  const values=collectLiteralEqualities(envelope?.statements?.[0]??"").filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024)throw new Error("DOCUMENT_GROUP_RESPONSE_REJECTED");
  return values[0].literal;
}

export function inspectDocumentGroupIntermediateResponse({result,mainEnvelope,documentEnvelope}){
  if(!Array.isArray(result?.columns)||!Array.isArray(result?.rows)||result.columns.length<1||result.columns.length>512||result.rows.length<1||result.rows.length>500||credentialColumns(result.columns).length)throw new Error("DOCUMENT_GROUP_RESPONSE_REJECTED");
  const matterValue=uniqueValue(mainEnvelope,"idx"),groupValue=uniqueValue(documentEnvelope,"GRP_KEY");
  const matches=value=>result.columns.map(column=>({column,matchingRowCount:result.rows.filter(row=>row?.[column]===value).length})).filter(item=>item.matchingRowCount>0);
  const matterIdentityCandidateColumns=matches(matterValue),documentGroupCandidateColumns=matches(groupValue);
  const jointRowCount=result.rows.filter(row=>matterIdentityCandidateColumns.some(item=>row?.[item.column]===matterValue)&&documentGroupCandidateColumns.some(item=>row?.[item.column]===groupValue)).length;
  return Object.freeze({status:documentGroupCandidateColumns.length?"document-group-intermediate-response-link-found":"document-group-intermediate-response-link-not-found",responseColumnCount:result.columns.length,responseRowCount:result.rows.length,responseColumns:Object.freeze([...result.columns]),matterIdentityCandidateColumns:Object.freeze(matterIdentityCandidateColumns.map(Object.freeze)),documentGroupCandidateColumns:Object.freeze(documentGroupCandidateColumns.map(Object.freeze)),jointRowCount,rawRowsReturned:false,internalValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false});
}
