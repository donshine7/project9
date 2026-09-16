import { credentialColumns } from "./response-schema.mjs";
import { compileResponsePredicateSet,verifyResponsePredicateSet } from "./response-predicate-set.mjs";
import { projectVerifiedDocumentList,resolveVerifiedDocumentDownload } from "./document-list.mjs";
import { createVerifiedDocumentSelection } from "./document-selection-context.mjs";
import { normalizeExactMatterReference } from "./matter-reference.mjs";
import {bindMatterIdentityDetailTemplate,bindMatterReferenceSearchTemplate,createMatterIdentityContext} from "./parameterized-read-template.mjs";

export class GeneralDocumentLookupError extends Error{
  constructor(code){super(code);this.name="GeneralDocumentLookupError";this.code=code;}
}

function exactSchema(result,expected){
  return Array.isArray(expected)&&expected.length>0&&Array.isArray(result?.columns)&&expected.length===result.columns.length&&expected.every((column,index)=>column===result.columns[index]);
}

// Candidate generic document chain. The caller supplies only the exact matter
// reference; GRP_KEY is derived from the fresh verified search identity.
export function createGeneralDocumentLookup({countDefinition,searchDefinition,documentDefinition,loadTemplate,executeRead}){
  const count=structuredClone(countDefinition),search=structuredClone(searchDefinition),document=structuredClone(documentDefinition);
  if(typeof loadTemplate!=="function"||typeof executeRead!=="function")throw new Error("GENERAL_DOCUMENT_PROVIDER_REJECTED");
  async function readVerified(matter){
    let countEnvelope,countResult,searchEnvelope,searchResult,context,documentEnvelope,documentResult,binding;
    try{
      countEnvelope=bindMatterReferenceSearchTemplate({envelope:await loadTemplate(count.templateId),definition:count,matterReference:matter});
      countResult=await executeRead({operation:"search-matter",role:"count-results",envelope:countEnvelope});
      if(!countResult||countResult.templateId!==count.templateId||!exactSchema(countResult,count.expectedResponseColumns)||!Array.isArray(countResult.rows)||countResult.rows.length!==1||countResult.rows[0]?.[count.responseCountColumn]!=="1"||credentialColumns(countResult.columns).length)throw new Error();
      searchEnvelope=bindMatterReferenceSearchTemplate({envelope:await loadTemplate(search.templateId),definition:search,matterReference:matter});
      searchResult=await executeRead({operation:"search-matter",role:"fetch-result-rows",envelope:searchEnvelope});
      context=createMatterIdentityContext({matterReference:matter,searchResult,definition:search});
    }catch{throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_SEARCH_REJECTED");}
    finally{countEnvelope=null;countResult=null;searchEnvelope=null;searchResult=null;}
    try{
      documentEnvelope=bindMatterIdentityDetailTemplate({envelope:await loadTemplate(document.templateId),definition:document,context});
      binding=compileResponsePredicateSet(documentEnvelope.statements[0],document.responsePredicateSetVerification);
      documentResult=await executeRead({operation:"list-documents",role:"document-records",envelope:documentEnvelope});
      if(!documentResult||documentResult.templateId!==document.templateId||!exactSchema(documentResult,document.expectedResponseColumns)||!Array.isArray(documentResult.rows)||documentResult.rows.length<1||documentResult.rows.length>500||credentialColumns(documentResult.columns).length)throw new Error();
      verifyResponsePredicateSet(documentResult,binding);
      return{matterReference:matter,result:{...documentResult,matterReference:matter}};
    }catch{throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_RESULT_REJECTED");}
    finally{context=null;documentEnvelope=null;binding=null;}
  }
  return Object.freeze({
    async list(input){
      if(!input||Object.keys(input).sort().join(",")!=="matterReference")throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_INPUT_REJECTED");
      let matter,verified;
      try{matter=normalizeExactMatterReference(input.matterReference);}catch{throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_INPUT_REJECTED");}
      verified=await readVerified(matter);
      try{return projectVerifiedDocumentList(verified.result,{matterReference:matter,responseBindingVerified:true});}
      catch{throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_RESULT_REJECTED");}
      finally{verified=null;}
    },
    async prepareDownload(input){
      if(!input||Object.keys(input).sort().join(",")!=="expectedFileName,matterReference,position")throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_INPUT_REJECTED");
      let matter,verified,target;
      try{matter=normalizeExactMatterReference(input.matterReference);}catch{throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_INPUT_REJECTED");}
      verified=await readVerified(matter);
      try{
        target=resolveVerifiedDocumentDownload(verified.result,{matterReference:matter,position:input.position,expectedFileName:input.expectedFileName,responseBindingVerified:true});
        return createVerifiedDocumentSelection(target);
      }catch{throw new GeneralDocumentLookupError("GENERAL_DOCUMENT_SELECTION_REJECTED");}
      finally{verified=null;target=null;}
    },
  });
}
