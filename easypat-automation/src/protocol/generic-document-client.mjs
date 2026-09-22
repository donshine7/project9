import {validateProtocolIntent} from "../core.mjs";
import {createGeneralDocumentLookup} from "./general-document-lookup.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./https-transport.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {parseResultset} from "./resultset.mjs";

const TEMPLATE_IDS=Object.freeze([
  "matter-search.exact-count.v1",
  "matter-search.exact-result.v1",
  "matter-detail.documents.matter-candidate.v1",
]);

function sameMembers(left,right){
  return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&new Set(left).size===left.length&&left.every(value=>right.includes(value));
}

// Production adapter for the live cross-matter-validated document-list chain.
// The public boundary accepts only a complete matter reference. The document
// group is always derived from the fresh, verified search result.
export function createGenericDocumentClient({policy,registry,loadTemplate,getSessionCookie,transport=createHttpsTransport()}){
  const fixedPolicy=structuredClone(policy),fixedRegistry=structuredClone(registry),constraint=fixedPolicy?.genericDocumentConstraints;
  if(fixedRegistry?.productionEnabled!==true||constraint?.enabled!==true||constraint?.mcpExposureEnabled!==true||
     !sameMembers(constraint?.enabledTemplateIds,TEMPLATE_IDS)||constraint?.maximumSearchCandidateCount!==500||constraint?.exactMatterReferenceMatchCountRequired!==1||
     constraint?.exactMatterReferenceMatchRequired!==true||constraint?.verifiedInternalIdentityRequired!==true||
     constraint?.documentGroupDerivedFromVerifiedIdentityRequired!==true||constraint?.allDocumentRowsPredicateSetMatchRequired!==true||
     constraint?.callerSuppliedGroupKeyAllowed!==false||constraint?.callerSuppliedSqlAllowed!==false||constraint?.automaticRetryEnabled!==false||
     fixedPolicy?.mutationOperationsEnabled!==false||fixedPolicy?.arbitrarySqlEnabled!==false||fixedPolicy?.tlsVerificationRequired!==true||
     typeof loadTemplate!=="function"||typeof getSessionCookie!=="function"||typeof transport!=="function")throw new Error("GENERIC_DOCUMENT_CONFIGURATION_REJECTED");
  const definition=id=>structuredClone(fixedRegistry.templates.find(template=>template.templateId===id));
  const countDefinition=definition(TEMPLATE_IDS[0]),searchDefinition=definition(TEMPLATE_IDS[1]),documentDefinition=definition(TEMPLATE_IDS[2]);
  if([countDefinition,searchDefinition,documentDefinition].some(item=>!item||item.productionEnabled!==true)||
     documentDefinition.requiredDistinctNonBaselineMatterValidations<2||
     documentDefinition.completedDistinctNonBaselineMatterValidations!==documentDefinition.requiredDistinctNonBaselineMatterValidations||
     !sameMembers(documentDefinition.validatedNonBaselineMatterReferences,fixedRegistry.authorizedNonBaselineMatterReferences)||
     !Array.isArray(documentDefinition.expectedResponseColumns)||documentDefinition.expectedResponseColumns.length!==27)throw new Error("GENERIC_DOCUMENT_CONFIGURATION_REJECTED");
  const roles=new Map([
    ["count-results",{operation:"search-matter",templateId:countDefinition.templateId}],
    ["fetch-result-rows",{operation:"search-matter",templateId:searchDefinition.templateId}],
    ["document-records",{operation:"list-documents",templateId:documentDefinition.templateId}],
  ]);
  const executeRead=async({operation,role,envelope})=>{
    const expected=roles.get(role);
    if(!expected||expected.operation!==operation||envelope?.templateId!==expected.templateId)throw new Error("GENERIC_DOCUMENT_READ_REJECTED");
    validateProtocolIntent(fixedPolicy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);
    let cookie,body,response;
    try{
      cookie=await getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();
      response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});
      if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("GENERIC_DOCUMENT_READ_REJECTED");
      const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};
    }finally{cookie=null;body=null;response=null;}
  };
  const lookup=createGeneralDocumentLookup({countDefinition,searchDefinition,documentDefinition,loadTemplate,executeRead});
  return Object.freeze({listDocuments:lookup.list,status:Object.freeze({enabled:true,templateCount:TEMPLATE_IDS.length,automaticRetryEnabled:false,downloadEnabled:false})});
}
