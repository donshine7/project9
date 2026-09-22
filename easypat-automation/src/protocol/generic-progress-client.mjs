import {validateProtocolIntent} from "../core.mjs";
import {createGeneralProgressLookup} from "./general-progress-lookup.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./https-transport.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {parseResultset} from "./resultset.mjs";

const TEMPLATE_IDS=Object.freeze(["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.progress-records.v1"]);
function sameMembers(left,right){return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&new Set(left).size===left.length&&left.every(value=>right.includes(value));}

export function createGenericProgressClient({policy,registry,loadTemplate,getSessionCookie,transport=createHttpsTransport()}){
  const fixedPolicy=structuredClone(policy),fixedRegistry=structuredClone(registry),constraint=fixedPolicy?.genericProgressConstraints;
  if(fixedRegistry?.productionEnabled!==true||constraint?.enabled!==true||constraint?.mcpExposureEnabled!==true||!sameMembers(constraint?.enabledTemplateIds,TEMPLATE_IDS)||
     constraint?.maximumSearchCandidateCount!==500||constraint?.exactMatterReferenceMatchCountRequired!==1||constraint?.exactMatterReferenceMatchRequired!==true||constraint?.verifiedInternalIdentityRequired!==true||
     constraint?.allProgressRowsIdentityMatchRequired!==true||constraint?.callerSuppliedSqlAllowed!==false||constraint?.automaticRetryEnabled!==false||
     fixedPolicy?.mutationOperationsEnabled!==false||fixedPolicy?.arbitrarySqlEnabled!==false||fixedPolicy?.tlsVerificationRequired!==true||
     typeof loadTemplate!=="function"||typeof getSessionCookie!=="function"||typeof transport!=="function")throw new Error("GENERIC_PROGRESS_CONFIGURATION_REJECTED");
  const definition=id=>structuredClone(fixedRegistry.templates.find(template=>template.templateId===id));
  const countDefinition=definition(TEMPLATE_IDS[0]),searchDefinition=definition(TEMPLATE_IDS[1]),progressDefinition=definition(TEMPLATE_IDS[2]);
  if([countDefinition,searchDefinition,progressDefinition].some(item=>!item||item.productionEnabled!==true)||
     progressDefinition.requiredDistinctNonBaselineMatterValidations<2||
     progressDefinition.completedDistinctNonBaselineMatterValidations!==progressDefinition.requiredDistinctNonBaselineMatterValidations||
     !sameMembers(progressDefinition.validatedNonBaselineMatterReferences,fixedRegistry.authorizedNonBaselineMatterReferences)||
     !Array.isArray(progressDefinition.expectedResponseColumns)||progressDefinition.expectedResponseColumns.length!==55)throw new Error("GENERIC_PROGRESS_CONFIGURATION_REJECTED");
  const roles=new Map([
    ["count-results",{operation:"search-matter",templateId:countDefinition.templateId}],
    ["fetch-result-rows",{operation:"search-matter",templateId:searchDefinition.templateId}],
    ["progress-records",{operation:"list-progress",templateId:progressDefinition.templateId}],
  ]);
  const executeRead=async({operation,role,envelope})=>{
    const expected=roles.get(role);if(!expected||expected.operation!==operation||envelope?.templateId!==expected.templateId)throw new Error("GENERIC_PROGRESS_READ_REJECTED");
    validateProtocolIntent(fixedPolicy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);
    let cookie,body,response;
    try{cookie=await getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("GENERIC_PROGRESS_READ_REJECTED");const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}
    finally{cookie=null;body=null;response=null;}
  };
  const lookup=createGeneralProgressLookup({countDefinition,searchDefinition,progressDefinition,loadTemplate,executeRead});
  return Object.freeze({listProgress:lookup.list,status:Object.freeze({enabled:true,templateCount:TEMPLATE_IDS.length,automaticRetryEnabled:false})});
}
