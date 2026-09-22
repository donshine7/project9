import {collectLiteralEqualities} from "./matter-linkage.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {diagnoseDocumentRequest} from "./document-request-diagnostic.mjs";
import {fingerprintEnvelope,fingerprintStatement} from "./template-fingerprint.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

function uniqueLiteral(envelope,column){
  const values=collectLiteralEqualities(envelope?.statements?.[0]??"").filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024||MASK.test(values[0].literal))throw new Error("DOCUMENT_GROUP_SOURCE_BASELINE_REJECTED");
  return values[0].literal;
}

export function inspectDocumentGroupSourceRequest({statement,mainEnvelope,progressEnvelope,intermediateEnvelope,documentEnvelope}){
  const shape=diagnoseDocumentRequest(statement);
  if(typeof statement!=="string"||!statement.length||statement.length>1024*1024||MASK.test(statement)||shape.shellSyntaxDetected||!shape.fromClauseObserved||!shape.predicateInspectionSupported)throw new Error("DOCUMENT_GROUP_SOURCE_REQUEST_REJECTED");
  const envelope={templateId:"matter-detail.document-group-source.v1",command:"SELECT",statements:[statement]};
  createReadOnlyBatch([envelope]);
  const targets=[
    {role:"matter-record",column:"idx",value:uniqueLiteral(mainEnvelope,"idx")},
    {role:"progress-parent",column:"idx_parent",value:uniqueLiteral(progressEnvelope,"idx_parent")},
    {role:"intermediate-record",column:"idx",value:uniqueLiteral(intermediateEnvelope,"idx")},
    {role:"document-group",column:"GRP_KEY",value:uniqueLiteral(documentEnvelope,"GRP_KEY")},
  ];
  const predicates=collectLiteralEqualities(statement),matches=[];
  for(const predicate of predicates){
    for(const target of targets){if(predicate.literal===target.value)matches.push({predicateColumn:predicate.column,targetRole:target.role,targetColumn:target.column});}
  }
  const matterIdentityPredicateColumns=[...new Set(matches.filter(item=>item.targetRole==="matter-record"||item.targetRole==="progress-parent").map(item=>item.predicateColumn))];
  const intermediateIdentityPredicateColumns=[...new Set(matches.filter(item=>item.targetRole==="intermediate-record").map(item=>item.predicateColumn))];
  const documentGroupPredicateColumns=[...new Set(matches.filter(item=>item.targetRole==="document-group").map(item=>item.predicateColumn))];
  const sameAsIntermediateStatement=fingerprintStatement(statement)===fingerprintStatement(intermediateEnvelope.statements[0]);
  const sourceClassification=matterIdentityPredicateColumns.length?"matter-bound-source-candidate":intermediateIdentityPredicateColumns.length?"duplicate-intermediate-query":"unbound-source-candidate";
  return Object.freeze({
    envelope,fingerprint:fingerprintEnvelope(envelope),sourceClassification,predicateCount:predicates.length,
    matterIdentityPredicateColumns:Object.freeze(matterIdentityPredicateColumns),
    intermediateIdentityPredicateColumns:Object.freeze(intermediateIdentityPredicateColumns),
    documentGroupPredicateColumns:Object.freeze(documentGroupPredicateColumns),
    sameAsIntermediateStatement,
    rawStatementsReturned:false,internalValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false,executable:false,
  });
}
