import { collectLiteralEqualities } from "./matter-linkage.mjs";
import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { fingerprintEnvelope } from "./template-fingerprint.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;
const PROGRESS_LINK_FIELDS=Object.freeze(["idx","idx_parent","serial","sourcecode","no_rec","sort"]);

function verifiedEnvelope(statement,candidate){
  if(typeof statement!=="string"||!statement.length||statement.length>1024*1024||MASK.test(statement)||
     candidate?.sessionId!==247||candidate.templateId!=="matter-detail.documents.v1"||candidate.command!=="SELECT"||candidate.statementCount!==1){
    throw new Error("DOCUMENT_LINKAGE_SOURCE_REJECTED");
  }
  const envelope={templateId:candidate.templateId,command:"SELECT",statements:[statement]};
  createReadOnlyBatch([envelope]);
  if(fingerprintEnvelope(envelope)!==candidate.fingerprint)throw new Error("DOCUMENT_LINKAGE_FINGERPRINT_REJECTED");
  return envelope;
}

function verifiedProgress(progressResult){
  if(progressResult?.matterReference!=="P261793"||progressResult.templateId!=="matter-detail.progress-records.v1"||
     !Array.isArray(progressResult.columns)||!PROGRESS_LINK_FIELDS.every(field=>progressResult.columns.includes(field))||
     !Array.isArray(progressResult.rows)||progressResult.rows.length<1||progressResult.rows.length>500){
    throw new Error("DOCUMENT_LINKAGE_PROGRESS_REJECTED");
  }
  return progressResult.rows;
}

export function inspectDocumentPredicateEvidence({statement,candidate,progressResult}){
  verifiedEnvelope(statement,candidate);const rows=verifiedProgress(progressResult),predicates=collectLiteralEqualities(statement),matches=[];
  for(const predicate of predicates){
    for(const field of PROGRESS_LINK_FIELDS){
      const rowIndexes=rows.map((row,index)=>({index,value:row?.[field]})).filter(item=>typeof item.value==="string"&&item.value.length>0&&item.value.length<=1024&&!MASK.test(item.value)&&item.value===predicate.literal).map(item=>item.index);
      if(rowIndexes.length)matches.push({predicateColumn:predicate.column,progressField:field,matchingRowCount:rowIndexes.length});
    }
  }
  const unique=[...new Map(matches.map(item=>[`${item.predicateColumn.toLowerCase()}|${item.progressField}`,item])).values()];
  return Object.freeze({status:unique.length?"document-predicate-progress-evidence-found":"document-predicate-progress-evidence-not-found",matterReference:"P261793",templateId:candidate.templateId,sourceSessionId:247,progressRowsExamined:rows.length,matches:unique,rawStatementsReturned:false,literalValuesReturned:false,internalIdentitiesReturned:false,executable:false});
}

function validBusinessResult(result,templateId,rowBounds){
  return result?.matterReference==="P261793"&&result.templateId===templateId&&Array.isArray(result.columns)&&result.columns.length>0&&Array.isArray(result.rows)&&result.rows.length>=rowBounds[0]&&result.rows.length<=rowBounds[1];
}

export function inspectDocumentBroadPredicateEvidence({statement,candidate,mainResult,progressResult}){
  verifiedEnvelope(statement,candidate);
  if(!validBusinessResult(mainResult,"matter-detail.main-record.v1",[1,1])||!validBusinessResult(progressResult,"matter-detail.progress-records.v1",[1,500]))throw new Error("DOCUMENT_LINKAGE_BUSINESS_SOURCE_REJECTED");
  const predicates=collectLiteralEqualities(statement),sources=[{role:"main-record",result:mainResult},{role:"progress-records",result:progressResult}],matches=[];
  for(const predicate of predicates){
    for(const source of sources){
      for(const column of source.result.columns){
        const matchingRowCount=source.result.rows.filter(row=>typeof row?.[column]==="string"&&row[column].length>0&&row[column].length<=4096&&!MASK.test(row[column])&&row[column]===predicate.literal).length;
        if(matchingRowCount)matches.push({predicateColumn:predicate.column,sourceRole:source.role,sourceColumn:column,matchingRowCount});
      }
    }
  }
  return Object.freeze({status:matches.length?"document-predicate-business-evidence-found":"document-predicate-business-evidence-not-found",matterReference:"P261793",templateId:candidate.templateId,sourceSessionId:247,predicateCount:predicates.length,mainRowsExamined:1,progressRowsExamined:progressResult.rows.length,matches:Object.freeze(matches),rawStatementsReturned:false,literalValuesReturned:false,businessValuesReturned:false,internalIdentitiesReturned:false,executable:false});
}

export function inspectDocumentProgressLinkage({statement,candidate,progressResult,expectedResponseColumns}){
  if(!Array.isArray(expectedResponseColumns)||expectedResponseColumns.length!==27){
    throw new Error("DOCUMENT_LINKAGE_SOURCE_REJECTED");
  }
  verifiedEnvelope(statement,candidate);const rows=verifiedProgress(progressResult);
  const progressKeys=rows.map(row=>row?.idx);
  if(progressKeys.some(value=>typeof value!=="string"||!value.length||value.length>1024||MASK.test(value))||new Set(progressKeys).size!==progressKeys.length){
    throw new Error("DOCUMENT_LINKAGE_PROGRESS_REJECTED");
  }
  const matches=collectLiteralEqualities(statement).filter(predicate=>progressKeys.includes(predicate.literal));
  const columns=[...new Set(matches.map(match=>match.column))];
  const matchedRows=progressKeys.filter(value=>matches.some(match=>match.literal===value));
  if(matches.length!==1||columns.length!==1||matchedRows.length!==1||
     !expectedResponseColumns.some(column=>column.toLowerCase()===columns[0].toLowerCase())){
    throw new Error("DOCUMENT_LINKAGE_NOT_UNIQUE");
  }
  return Object.freeze({status:"document-template-linked-to-p261793-progress",matterReference:"P261793",templateId:candidate.templateId,sourceSessionId:candidate.sessionId,matchingPredicateCount:1,matchingPredicateColumn:columns[0],matchedProgressRowCount:1,progressRowsExamined:progressKeys.length,captureFingerprintMatched:true,rawStatementsReturned:false,internalIdentitiesReturned:false,executable:false});
}
