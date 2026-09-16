import {collectLiteralEqualities} from "./matter-linkage.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {fingerprintEnvelope} from "./template-fingerprint.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

function uniqueValue(sql,column){
  const values=collectLiteralEqualities(sql).filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024||MASK.test(values[0].literal))throw new Error("DOCUMENT_GROUP_INTERMEDIATE_REJECTED");
  return values[0].literal;
}

export function inspectDocumentGroupIntermediateRequest({statement,mainEnvelope,documentEnvelope}){
  if(typeof statement!=="string"||!statement.length||statement.length>1024*1024||MASK.test(statement)||
     mainEnvelope?.templateId!=="matter-detail.main-record.v1"||documentEnvelope?.templateId!=="matter-detail.documents.v1")throw new Error("DOCUMENT_GROUP_INTERMEDIATE_REJECTED");
  const envelope={templateId:"matter-detail.document-group-intermediate.v1",command:"SELECT",statements:[statement]};
  createReadOnlyBatch([envelope]);createReadOnlyBatch([mainEnvelope]);createReadOnlyBatch([documentEnvelope]);
  const matterValue=uniqueValue(mainEnvelope.statements[0],"idx"),documentGroupValue=uniqueValue(documentEnvelope.statements[0],"GRP_KEY");
  let predicates,predicateInspectionSupported=true;
  try{predicates=collectLiteralEqualities(statement);}catch{predicates=[];predicateInspectionSupported=false;}
  const matterIdentityPredicateColumns=predicates.filter(item=>item.literal===matterValue).map(item=>item.column),documentGroupPredicateColumns=predicates.filter(item=>item.literal===documentGroupValue).map(item=>item.column);
  if(matterIdentityPredicateColumns.length>16||documentGroupPredicateColumns.length>16)throw new Error("DOCUMENT_GROUP_INTERMEDIATE_REJECTED");
  return Object.freeze({envelope,fingerprint:fingerprintEnvelope(envelope),matterIdentityPredicateColumns:Object.freeze([...matterIdentityPredicateColumns]),documentGroupPredicateColumns:Object.freeze([...documentGroupPredicateColumns]),matterIdentityBindingObserved:matterIdentityPredicateColumns.length>0,documentGroupPredicateObserved:documentGroupPredicateColumns.length>0,predicateInspectionSupported,predicateCount:predicateInspectionSupported?predicates.length:null,rawStatementsReturned:false,internalValuesReturned:false,serverRequestsPerformed:0,executable:false});
}
