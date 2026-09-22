import {collectLiteralEqualities} from "./matter-linkage.mjs";
import {credentialColumns} from "./response-schema.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;

export class DocumentGroupProgressBridgeError extends Error{
  constructor(code,diagnostic){super(code);this.name="DocumentGroupProgressBridgeError";this.code=code;this.safeDiagnostic=diagnostic;}
}

function uniqueLiteral(envelope,column){
  const values=collectLiteralEqualities(envelope?.statements?.[0]??"").filter(item=>item.column.toLowerCase()===column.toLowerCase());
  if(values.length!==1||typeof values[0].literal!=="string"||!values[0].literal.length||values[0].literal.length>1024||MASK.test(values[0].literal))throw new Error("DOCUMENT_GROUP_BRIDGE_TEMPLATE_REJECTED");
  return values[0].literal;
}

function exactResult(result,expected,{minimumRows,maximumRows}){
  if(!Array.isArray(expected)||!expected.length||!Array.isArray(result?.columns)||result.columns.length!==expected.length||
     !expected.every((column,index)=>column===result.columns[index])||credentialColumns(result.columns).length||
     !Array.isArray(result.rows)||result.rows.length<minimumRows||result.rows.length>maximumRows)throw new Error("DOCUMENT_GROUP_BRIDGE_RESULT_REJECTED");
}

// Proves the baseline chain only. Compared identities stay in memory and are
// neither returned nor persisted. It does not authorize a generic selector.
export function inspectDocumentGroupProgressBridge({mainEnvelope,progressEnvelope,progressResult,intermediateEnvelope,intermediateResult,documentEnvelope,expectedColumns}){
  exactResult(progressResult,expectedColumns,{minimumRows:1,maximumRows:500});
  exactResult(intermediateResult,expectedColumns,{minimumRows:1,maximumRows:1});
  const mainIdentity=uniqueLiteral(mainEnvelope,"idx");
  const progressParent=uniqueLiteral(progressEnvelope,"idx_parent");
  const intermediateIdentity=uniqueLiteral(intermediateEnvelope,"idx");
  const documentGroup=uniqueLiteral(documentEnvelope,"GRP_KEY");
  const intermediateRow=intermediateResult.rows[0];
  const matchingProgressRows=progressResult.rows.filter(row=>row?.idx===intermediateIdentity);
  const diagnostic=Object.freeze({
    progressTemplateBoundToMain:progressParent===mainIdentity,
    allProgressRowsBoundToTemplate:progressResult.rows.every(row=>row?.idx_parent===progressParent),
    intermediateRequestReturnedSameIdentity:intermediateRow?.idx===intermediateIdentity,
    intermediateReturnedDocumentGroup:intermediateRow?.idx_parent===documentGroup,
    matchingProgressRowCount:matchingProgressRows.length,
    matchingProgressRowParentMatchedDocumentGroup:matchingProgressRows.length===1?matchingProgressRows[0]?.idx_parent===documentGroup:null,
    rawValuesReturned:false,
  });
  if(!diagnostic.progressTemplateBoundToMain||!diagnostic.allProgressRowsBoundToTemplate||!diagnostic.intermediateRequestReturnedSameIdentity||
     !diagnostic.intermediateReturnedDocumentGroup||diagnostic.matchingProgressRowCount!==1||diagnostic.matchingProgressRowParentMatchedDocumentGroup!==true){
    throw new DocumentGroupProgressBridgeError("DOCUMENT_GROUP_BRIDGE_COMPARISON_REJECTED",diagnostic);
  }
  return Object.freeze({
    status:"document-group-progress-bridge-validated",
    progressResponseRowCount:progressResult.rows.length,
    intermediateResponseRowCount:1,
    intermediateRequestPredicateColumn:"idx",
    progressMatchColumn:"idx",
    progressParentColumn:"idx_parent",
    documentGroupResponseColumn:"idx_parent",
    documentTargetPredicateColumn:"GRP_KEY",
    matchedProgressRowCount:1,
    progressMatterBindingVerified:true,
    intermediateRequestResponseVerified:true,
    documentGroupBindingVerified:true,
    rawRowsReturned:false,
    internalValuesReturned:false,
    serverRequestsPerformed:0,
    productionEnabled:false,
  });
}
