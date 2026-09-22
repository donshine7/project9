import {validateProtocolIntent} from "../core.mjs";
import {createHttpsTransport,EASYPAT_ENDPOINT} from "./https-transport.mjs";
import {createNoticeAttachmentLookup} from "./notice-attachment-lookup.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {parseResultset} from "./resultset.mjs";

const SOURCE_TEMPLATE_IDS=Object.freeze(["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.progress-records.v1","matter-detail.related-counts.v1"]);
const VALIDATED_REFERENCES=Object.freeze(["P261048","P261315","P261487","P261489","P261610"]);
function sameMembers(left,right){return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&new Set(left).size===left.length&&left.every(value=>right.includes(value));}

export function createGenericNoticeAttachmentClient({policy,registry,protocolCandidates,loadTemplate,getSessionCookie,transport=createHttpsTransport()}){
  const fixedPolicy=structuredClone(policy),fixedRegistry=structuredClone(registry),candidates=structuredClone(protocolCandidates),constraint=fixedPolicy?.genericNoticeAttachmentConstraints;
  if(constraint?.enabled!==true||constraint?.mcpExposureEnabled!==true||!sameMembers(constraint.sourceTemplateIds,SOURCE_TEMPLATE_IDS)||constraint.derivedTemplateId!=="matter-detail.attachments.all.v1"||
     constraint.maximumSearchCandidateCount!==500||constraint.exactMatterReferenceMatchCountRequired!==1||constraint.exactProgressRowMatchRequired!==1||constraint.aggregateCountMatchRequired!==true||
     constraint.contiguousNoticePackageRequired!==true||constraint.callerSuppliedSqlAllowed!==false||constraint.callerSuppliedInternalIdentityAllowed!==false||constraint.automaticRetryEnabled!==false||
     constraint.requiredDistinctMatterValidations!==5||!sameMembers(constraint.validatedMatterReferences,VALIDATED_REFERENCES)||fixedPolicy?.mutationOperationsEnabled!==false||fixedPolicy?.arbitrarySqlEnabled!==false||fixedPolicy?.tlsVerificationRequired!==true||
     typeof loadTemplate!=="function"||typeof getSessionCookie!=="function"||typeof transport!=="function")throw new Error("GENERIC_NOTICE_ATTACHMENT_CONFIGURATION_REJECTED");
  const definition=id=>structuredClone(fixedRegistry.templates.find(template=>template.templateId===id));
  const countDefinition=definition(SOURCE_TEMPLATE_IDS[0]),searchDefinition=definition(SOURCE_TEMPLATE_IDS[1]),progressDefinition=definition(SOURCE_TEMPLATE_IDS[2]),documentDefinition=definition("matter-detail.documents.matter-candidate.v1"),relatedCandidate=candidates.find(candidate=>candidate.templateId===SOURCE_TEMPLATE_IDS[3]);
  if([countDefinition,searchDefinition,progressDefinition,documentDefinition].some(item=>!item||item.productionEnabled!==true)||relatedCandidate?.fingerprint===undefined||documentDefinition.expectedResponseColumns?.length!==27)throw new Error("GENERIC_NOTICE_ATTACHMENT_CONFIGURATION_REJECTED");
  const roles=new Map([["count-results",["search-matter",countDefinition.templateId]],["fetch-result-rows",["search-matter",searchDefinition.templateId]],["progress-records",["list-progress",progressDefinition.templateId]],["attachment-count",["get-matter-detail",relatedCandidate.templateId]],["matter-attachment-records",["list-documents","matter-detail.attachments.all.v1"]]]);
  const executeRead=async({operation,role,envelope})=>{
    const expected=roles.get(role);if(!expected||expected[0]!==operation||expected[1]!==envelope?.templateId)throw new Error("GENERIC_NOTICE_ATTACHMENT_READ_REJECTED");
    validateProtocolIntent(fixedPolicy,{url:EASYPAT_ENDPOINT,operation,mutates:false});createReadOnlyBatch([envelope]);let cookie,body,response;
    try{cookie=await getSessionCookie();body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:envelope.statements[0]}).toString();response=await transport({endpoint:EASYPAT_ENDPOINT,body,cookie});if(response?.status!==200||response.contentType!=="text/resultset")throw new Error("GENERIC_NOTICE_ATTACHMENT_READ_REJECTED");const parsed=parseResultset(response.text);return{templateId:envelope.templateId,columns:parsed.columns,rows:parsed.rows};}
    finally{cookie=null;body=null;response=null;}
  };
  const lookup=createNoticeAttachmentLookup({countDefinition,searchDefinition,progressDefinition,documentDefinition,relatedCandidate,loadTemplate,executeRead});
  return Object.freeze({listNoticeAttachments:lookup.list,prepareNoticePackage:lookup.preparePackage,status:Object.freeze({enabled:true,templateCount:5,automaticRetryEnabled:false,validatedMatterCount:VALIDATED_REFERENCES.length})});
}
