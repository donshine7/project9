import {collectLiteralEqualities} from "./matter-linkage.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {fingerprintEnvelope} from "./template-fingerprint.mjs";

const SHA256=/^[a-f0-9]{64}$/;

function statement(envelope,candidate){
  if(!envelope||envelope.templateId!==candidate?.templateId||envelope.command!=="SELECT"||!Array.isArray(envelope.statements)||envelope.statements.length!==1||
     !SHA256.test(candidate?.fingerprint??"")||fingerprintEnvelope(envelope)!==candidate.fingerprint)throw new Error("DOCUMENT_GROUP_SOURCE_REJECTED");
  createReadOnlyBatch([envelope]);return envelope.statements[0];
}

function uniqueGroupValue(documentStatement){
  const groups=collectLiteralEqualities(documentStatement).filter(item=>item.column.toLowerCase()==="grp_key");
  if(groups.length!==1||typeof groups[0].literal!=="string"||!groups[0].literal.length||groups[0].literal.length>1024)throw new Error("DOCUMENT_GROUP_SOURCE_REJECTED");
  return groups[0].literal;
}

// Evidence only: reports template and predicate column names whose captured
// literal equals the document GRP_KEY. It never returns either literal.
export function inspectCapturedDocumentGroupSources({documentEnvelope,documentCandidate,sources}){
  if(documentCandidate?.templateId!=="matter-detail.documents.v1"||!Array.isArray(sources)||!sources.length)throw new Error("DOCUMENT_GROUP_SOURCE_REJECTED");
  const groupValue=uniqueGroupValue(statement(documentEnvelope,documentCandidate)),matches=[];
  for(const source of sources){
    const sql=statement(source.envelope,source.candidate),columns=collectLiteralEqualities(sql).filter(item=>item.literal===groupValue).map(item=>item.column);
    for(const column of [...new Set(columns.map(item=>item.toLowerCase()))])matches.push({templateId:source.candidate.templateId,predicateColumn:columns.find(item=>item.toLowerCase()===column)});
  }
  return Object.freeze({status:matches.length?"captured-document-group-source-candidates-found":"captured-document-group-source-not-found",matchCount:matches.length,matches:Object.freeze(matches.map(Object.freeze)),fingerprintsVerified:true,rawStatementsReturned:false,internalValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false,limitation:"Captured literal equality is discovery evidence only and does not authorize parameter binding."});
}
