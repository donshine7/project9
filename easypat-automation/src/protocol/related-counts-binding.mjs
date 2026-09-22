import {collectLiteralEqualities} from "./matter-linkage.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;
function uniqueLiteral(envelope,column){
  const values=collectLiteralEqualities(envelope?.statements?.[0]??"").filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024||MASK.test(values[0].literal))throw new Error("RELATED_COUNTS_BASELINE_REJECTED");
  return values[0].literal;
}

export function inspectRelatedCountsBinding({mainEnvelope,relatedEnvelope}){
  if(mainEnvelope?.templateId!=="matter-detail.main-record.v1"||relatedEnvelope?.templateId!=="matter-detail.related-counts.v1"||relatedEnvelope.command!=="SELECT"||relatedEnvelope.statements?.length!==1)throw new Error("RELATED_COUNTS_TEMPLATE_REJECTED");
  createReadOnlyBatch([mainEnvelope,relatedEnvelope]);
  const matterIdentity=uniqueLiteral(mainEnvelope,"idx"),predicates=collectLiteralEqualities(relatedEnvelope.statements[0]);
  const matterIdentityPredicateColumns=[...new Set(predicates.filter(item=>item.literal===matterIdentity).map(item=>item.column))];
  const matterIdentityPredicateOccurrences=matterIdentityPredicateColumns.map(column=>Object.freeze({column,occurrenceCount:predicates.filter(item=>item.literal===matterIdentity&&item.column.toLowerCase()===column.toLowerCase()).length}));
  return Object.freeze({status:matterIdentityPredicateColumns.length?"related-counts-matter-binding-observed":"related-counts-matter-binding-not-found",predicateCount:predicates.length,matterIdentityPredicateColumns:Object.freeze(matterIdentityPredicateColumns),matterIdentityPredicateOccurrences:Object.freeze(matterIdentityPredicateOccurrences),matterBindingObserved:matterIdentityPredicateColumns.length>0,rawStatementsReturned:false,internalValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false});
}
