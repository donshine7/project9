import {validateProtocolIntent} from "../core.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./https-transport.mjs";
import {createProgressDocumentLookup} from "./progress-document-lookup.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {parseResultset} from "./resultset.mjs";

const TEMPLATE_IDS=Object.freeze([
  "matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.progress-records.v1",
  "matter-detail.document-group-intermediate.v2","matter-detail.progress-documents.v1",
]);
function sameMembers(left,right){return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&new Set(left).size===left.length&&left.every(value=>right.includes(value));}

export function createGenericProgressDocumentClient({policy,registry,loadTemplate,getSessionCookie,transport=createHttpsTransport()}){
  const fixedPolicy=structuredClone(policy),fixedRegistry=structuredClone(registry),constraint=fixedPolicy?.genericProgressDocumentConstraints;
  if(fixedRegistry?.productionEnabled!==true||constraint?.enabled!==true||constraint?.mcpExposureEnabled!==true||!sameMembers(constraint.enabledTemplateIds,TEMPLATE_IDS)||
     constraint.maximumSearchCandidateCount!==500||constraint.exactMatterReferenceMatchCountRequired!==1||constraint.exactMatterReferenceMatchRequired!==true||constraint.verifiedInternalIdentityRequired!==true||
     constraint.exactProgressDocumentMatchRequired!==true||constraint.intermediateIdentityBindingRequired!==true||constraint.allDocumentRowsPredicateSetMatchRequired!==true||
     constraint.callerSuppliedGroupKeyAllowed!==false||constraint.callerSuppliedSqlAllowed!==false||constraint.automaticRetryEnabled!==false||
     fixedPolicy.mutationOperationsEnabled!==false||fixedPolicy.arbitrarySqlEnabled!==false||fixedPolicy.tlsVerificationRequired!==true||
     typeof loadTemplate!=="function"||typeof getSessionCookie!=="function"||typeof transport!=="function")throw new Error("GENERIC_PROGRESS_DOCUMENT_CONFIGURATION_REJECTED");
  const definition=id=>structuredClone(fixedRegistry.templates.find(template=>template.templateId===id));
  const [countDefinition,searchDefinition,progressDefinition,intermediateDefinition,documentDefinition]=TEMPLATE_IDS.map(definition);
  if([countDefinition,searchDefinition,progressDefinition,intermediateDefinition,documentDefinition].some(item=>!item||item.productionEnabled!==true)||
     constraint.requiredDistinctMatterValidations!==2||!sameMembers(constraint.validatedMatterReferences,["PT261268","P261793"])||
     intermediateDefinition.expectedResponseColumns?.length!==55||documentDefinition.expectedResponseColumns?.length!==27)throw new Error("GENERIC_PROGRESS_DOCUMENT_CONFIGURATION_REJECTED");
  const roles=new Map([["count-results",["search-matter",countDefinition.templateId]],["fetch-result-rows",["search-matter",searchDefinition.templateId]],["progress-records",["list-progress",progressDefinition.templateId]],["document-group-record",["list-documents",intermediateDefinition.templateId]],["progress-document-records",["list-documents",documentDefinition.templateId]]]);
  const executeRead=async({operation,role,envelope})=>{
    const expected=roles.get(role);if(!expected||expected[0]!==operation||expected[1]!==envelope?.templateId)throw new Error("GENERIC_PROGRESS_DOCUMENT_READ_REJECTED");
    validateProtocolIntent(fixedPolicy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);let cookie,body,response;
    try{cookie=await getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("GENERIC_PROGRESS_DOCUMENT_READ_REJECTED");const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}
    finally{cookie=null;body=null;response=null;}
  };
  const lookup=createProgressDocumentLookup({countDefinition,searchDefinition,progressDefinition,intermediateDefinition,documentDefinition,loadTemplate,executeRead});
  return Object.freeze({listDocuments:lookup.list,prepareDownload:lookup.prepareDownload,status:Object.freeze({enabled:true,templateCount:TEMPLATE_IDS.length,automaticRetryEnabled:false,downloadReady:fixedPolicy.genericDownloadConstraints?.enabled===true})});
}
