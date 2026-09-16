import { collectLiteralEqualities } from "./matter-linkage.mjs";
import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { fingerprintEnvelope } from "./template-fingerprint.mjs";

const SHA256=/^[a-f0-9]{64}$/;

function verifiedStatement(envelope,{templateId,fingerprint}){
  if(!envelope||envelope.templateId!==templateId||envelope.command!=="SELECT"||
     !Array.isArray(envelope.statements)||envelope.statements.length!==1||!SHA256.test(fingerprint??"")||
     fingerprintEnvelope(envelope)!==fingerprint)throw new Error("DOCUMENT_GROUP_TEMPLATE_REJECTED");
  createReadOnlyBatch([envelope]);
  return envelope.statements[0];
}

function uniqueLiteral(statement,column){
  const values=collectLiteralEqualities(statement).filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024){
    throw new Error("DOCUMENT_GROUP_SLOT_REJECTED");
  }
  return values[0].literal;
}

// This proves only the captured baseline chain. It does not execute either
// statement and never returns the compared internal value.
export function inspectCapturedDocumentGroupBinding({mainEnvelope,documentEnvelope,mainCandidate,documentCandidate}){
  if(mainCandidate?.templateId!=="matter-detail.main-record.v1"||documentCandidate?.templateId!=="matter-detail.documents.v1"){
    throw new Error("DOCUMENT_GROUP_TEMPLATE_REJECTED");
  }
  const mainValue=uniqueLiteral(verifiedStatement(mainEnvelope,mainCandidate),"idx");
  const documentValue=uniqueLiteral(verifiedStatement(documentEnvelope,documentCandidate),"GRP_KEY");
  if(mainValue!==documentValue)throw new Error("DOCUMENT_GROUP_IDENTITY_MISMATCH");
  return Object.freeze({
    status:"captured-document-group-bound-to-matter-identity",
    sourceTemplateId:mainCandidate.templateId,
    sourceColumn:"idx",
    targetTemplateId:documentCandidate.templateId,
    targetPredicateColumn:"GRP_KEY",
    valuesMatched:true,
    fingerprintsVerified:true,
    rawStatementsReturned:false,
    internalValuesReturned:false,
    serverRequestsPerformed:0,
    productionEnabled:false,
  });
}
