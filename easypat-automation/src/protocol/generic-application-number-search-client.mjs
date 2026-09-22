import {validateProtocolIntent} from "../core.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./https-transport.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {parseResultset} from "./resultset.mjs";
import {createApplicationNumberSearch} from "./application-number-search.mjs";

const SOURCE_TEMPLATE_IDS=Object.freeze(["matter-search.exact-count.v1","matter-search.exact-result.v1"]);

function sameMembers(left,right){
  return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&new Set(left).size===left.length&&left.every(value=>right.includes(value));
}

export function createGenericApplicationNumberSearchClient({
  policy,
  registry,
  loadTemplate,
  getSessionCookie,
  transport=createHttpsTransport(),
  validationOnly=false,
}){
  const fixedPolicy=structuredClone(policy),fixedRegistry=structuredClone(registry);
  const constraint=fixedPolicy?.genericApplicationNumberSearchConstraints;
  const derivation=fixedRegistry?.applicationNumberSearch;
  const commonReady=fixedRegistry?.productionEnabled===true&&
    sameMembers(derivation?.sourceTemplateIds,SOURCE_TEMPLATE_IDS)&&
    sameMembers(constraint?.sourceTemplateIds,SOURCE_TEMPLATE_IDS)&&
    derivation?.sourcePredicateColumn==="ourref"&&derivation?.targetPredicateColumn==="n_app"&&
    derivation?.responseApplicationNumberColumn==="n_app"&&derivation?.maximumSearchCandidateCount===500&&
    constraint?.maximumSearchCandidateCount===500&&constraint?.exactApplicationNumberMatchRequired===true&&
    constraint?.callerSuppliedSqlAllowed===false&&constraint?.automaticRetryEnabled===false&&
    fixedPolicy?.mutationOperationsEnabled===false&&fixedPolicy?.arbitrarySqlEnabled===false&&fixedPolicy?.tlsVerificationRequired===true&&
    typeof loadTemplate==="function"&&typeof getSessionCookie==="function"&&typeof transport==="function";
  const productionReady=commonReady&&derivation?.productionEnabled===true&&derivation?.liveValidationPending===false&&
    constraint?.enabled===true&&constraint?.mcpExposureEnabled===true&&
    derivation?.requiredDistinctMatterValidations>=2&&
    derivation.completedDistinctMatterValidations===derivation.requiredDistinctMatterValidations&&
    Array.isArray(derivation.validatedMatterReferences)&&
    new Set(derivation.validatedMatterReferences).size===derivation.requiredDistinctMatterValidations;
  const validationReady=commonReady&&validationOnly===true&&derivation?.productionEnabled===false&&
    derivation?.liveValidationPending===true&&constraint?.enabled===false&&constraint?.mcpExposureEnabled===false;
  if(!productionReady&&!validationReady)throw new Error("GENERIC_APPLICATION_SEARCH_CONFIGURATION_REJECTED");

  const definition=id=>structuredClone(fixedRegistry.templates.find(template=>template.templateId===id));
  const countDefinition=definition(SOURCE_TEMPLATE_IDS[0]),searchDefinition=definition(SOURCE_TEMPLATE_IDS[1]);
  if([countDefinition,searchDefinition].some(item=>!item||item.productionEnabled!==true))throw new Error("GENERIC_APPLICATION_SEARCH_CONFIGURATION_REJECTED");
  const roles=new Map([
    ["count-application-results",{operation:"search-matter",templateId:countDefinition.templateId}],
    ["fetch-application-result-rows",{operation:"search-matter",templateId:searchDefinition.templateId}],
  ]);
  const executeRead=async({operation,role,envelope})=>{
    const expected=roles.get(role);
    if(!expected||expected.operation!==operation||envelope?.templateId!==expected.templateId)throw new Error("GENERIC_APPLICATION_SEARCH_READ_REJECTED");
    validateProtocolIntent(fixedPolicy,{url:EASYPAT_ENDPOINT,operation,mutates:false});
    createReadOnlyBatch([envelope]);
    let cookie,body,response;
    try{
      cookie=await getSessionCookie();
      body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();
      response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});
      if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("GENERIC_APPLICATION_SEARCH_READ_REJECTED");
      const parsed=parseResultset(response.text);
      return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};
    }finally{cookie=null;body=null;response=null;}
  };
  const lookup=createApplicationNumberSearch({countDefinition,searchDefinition,derivation,loadTemplate,executeRead});
  return Object.freeze({
    search:lookup.search,
    status:Object.freeze({enabled:productionReady,validationOnly:validationReady,templateCount:SOURCE_TEMPLATE_IDS.length,automaticRetryEnabled:false}),
  });
}
