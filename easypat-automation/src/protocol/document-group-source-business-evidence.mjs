import {collectLiteralEqualities} from "./matter-linkage.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

function uniqueLiteral(envelope,column){
  const values=collectLiteralEqualities(envelope?.statements?.[0]??"").filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024||MASK.test(values[0].literal))throw new Error("DOCUMENT_GROUP_BUSINESS_TARGET_REJECTED");
  return values[0].literal;
}

function validResult(result,templateId,{minimumRows,maximumRows}){
  if(result?.matterReference!=="P261793"||result.templateId!==templateId||!Array.isArray(result.columns)||!result.columns.length||
     !Array.isArray(result.rows)||result.rows.length<minimumRows||result.rows.length>maximumRows)throw new Error("DOCUMENT_GROUP_BUSINESS_RESULT_REJECTED");
}

export function inspectDocumentGroupSourceBusinessEvidence({sourceEnvelope,documentEnvelope,mainResult,progressResult}){
  validResult(mainResult,"matter-detail.main-record.v1",{minimumRows:1,maximumRows:1});
  validResult(progressResult,"matter-detail.progress-records.v1",{minimumRows:1,maximumRows:500});
  const predicates=collectLiteralEqualities(sourceEnvelope?.statements?.[0]??"");
  if(!predicates.length||predicates.length>32)throw new Error("DOCUMENT_GROUP_BUSINESS_SOURCE_REJECTED");
  const documentGroup=uniqueLiteral(documentEnvelope,"GRP_KEY"),sources=[{role:"main-record",result:mainResult},{role:"progress-records",result:progressResult}],matches=[];
  for(const predicate of predicates){
    for(const source of sources){
      for(const column of source.result.columns){
        const matchingRowCount=source.result.rows.filter(row=>typeof row?.[column]==="string"&&row[column].length>0&&row[column].length<=4096&&!MASK.test(row[column])&&row[column]===predicate.literal).length;
        if(matchingRowCount)matches.push({predicateColumn:predicate.column,sourceRole:source.role,sourceColumn:column,matchingRowCount,documentGroupPredicate:predicate.literal===documentGroup});
      }
    }
  }
  const documentGroupMatches=matches.filter(item=>item.documentGroupPredicate);
  return Object.freeze({
    status:documentGroupMatches.length?"document-group-source-business-evidence-found":"document-group-source-business-evidence-not-found",
    matterReference:"P261793",sourcePredicateCount:predicates.length,mainRowsExamined:1,progressRowsExamined:progressResult.rows.length,
    matchCount:matches.length,documentGroupMatchCount:documentGroupMatches.length,
    matches:Object.freeze(matches.map(Object.freeze)),
    rawRowsReturned:false,businessValuesReturned:false,internalValuesReturned:false,serverMutationPerformed:false,automaticRetryPerformed:false,productionEnabled:false,
  });
}
