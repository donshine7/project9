import {credentialColumns} from "./response-schema.mjs";
import {compilePredicateResponseIdentity,verifyPredicateResponseIdentity} from "./response-identity.mjs";
import {compileResponsePredicateSet,verifyResponsePredicateSet} from "./response-predicate-set.mjs";
import {projectVerifiedDocumentList,resolveVerifiedDocumentDownload} from "./document-list.mjs";
import {createVerifiedDocumentSelection} from "./document-selection-context.mjs";
import {normalizeExactMatterReference} from "./matter-reference.mjs";
import {
  bindMatterIdentityDetailTemplate,
  bindMatterReferenceSearchTemplate,
  bindTrustedDerivedScalarTemplate,
  createMatterIdentityContext,
  readMatterSearchCandidateCount,
} from "./parameterized-read-template.mjs";

export class ProgressDocumentLookupError extends Error{
  constructor(code){super(code);this.name="ProgressDocumentLookupError";this.code=code;}
}

function exactSchema(result,expected){
  return Array.isArray(expected)&&expected.length>0&&Array.isArray(result?.columns)&&
    expected.length===result.columns.length&&expected.every((column,index)=>column===result.columns[index]);
}

function safeLabel(value){
  if(typeof value!=="string"||!value.length||value.length>512||value!==value.trim()||/[\p{Cc}\p{Cs}]/u.test(value)){
    throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_INPUT_REJECTED");
  }
  return value;
}

function safeIdentity(value){
  if(typeof value!=="string"||!value.length||value.length>1024||/[\p{Cc}\p{Cs}]/u.test(value)||/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i.test(value))throw new Error();
  return value;
}

// This is the verified bridge for documents attached to a progress item:
// exact matter -> progress row -> intermediate document group -> documents.
// The public caller supplies only business identifiers; idx/idx_parent/GRP_KEY
// stay inside this closure and are never returned.
export function createProgressDocumentLookup({countDefinition,searchDefinition,progressDefinition,intermediateDefinition,progressGroupSourceColumn,documentDefinition,loadTemplate,executeRead}){
  const count=structuredClone(countDefinition),search=structuredClone(searchDefinition),progress=structuredClone(progressDefinition),
    intermediate=intermediateDefinition===undefined?undefined:structuredClone(intermediateDefinition),document=structuredClone(documentDefinition);
  if(typeof loadTemplate!=="function"||typeof executeRead!=="function")throw new Error("PROGRESS_DOCUMENT_PROVIDER_REJECTED");
  const directGroup=progressGroupSourceColumn!==undefined;
  if(directGroup&&(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(progressGroupSourceColumn)||!progress.expectedResponseColumns?.includes(progressGroupSourceColumn)||intermediate!==undefined))throw new Error("PROGRESS_DOCUMENT_PROVIDER_REJECTED");
  if(!directGroup&&!intermediate)throw new Error("PROGRESS_DOCUMENT_PROVIDER_REJECTED");

  async function readVerified({matterReference,progressDocument}){
    let matter,label,countEnvelope,countResult,candidateCount,searchEnvelope,searchResult,matterContext,progressEnvelope,progressResult,progressBinding,
      selectedProgress,progressIdentity,intermediateEnvelope,intermediateResult,intermediateBinding,documentGroup,
      documentEnvelope,documentResult,documentBinding;
    try{matter=normalizeExactMatterReference(matterReference);label=safeLabel(progressDocument);}
    catch(error){if(error instanceof ProgressDocumentLookupError)throw error;throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_INPUT_REJECTED");}
    try{
      countEnvelope=bindMatterReferenceSearchTemplate({envelope:await loadTemplate(count.templateId),definition:count,matterReference:matter});
      countResult=await executeRead({operation:"search-matter",role:"count-results",envelope:countEnvelope});
      if(!countResult||countResult.templateId!==count.templateId||!exactSchema(countResult,count.expectedResponseColumns)||credentialColumns(countResult.columns).length)throw new Error();
      candidateCount=readMatterSearchCandidateCount({result:countResult,definition:count});
      searchEnvelope=bindMatterReferenceSearchTemplate({envelope:await loadTemplate(search.templateId),definition:search,matterReference:matter});
      searchResult=await executeRead({operation:"search-matter",role:"fetch-result-rows",envelope:searchEnvelope});
      if(!Array.isArray(searchResult?.rows)||searchResult.rows.length!==candidateCount)throw new Error();
      matterContext=createMatterIdentityContext({matterReference:matter,searchResult,definition:search});
    }catch{throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_SEARCH_REJECTED");}
    finally{countEnvelope=null;countResult=null;candidateCount=null;searchEnvelope=null;searchResult=null;}
    try{
      progressEnvelope=bindMatterIdentityDetailTemplate({envelope:await loadTemplate(progress.templateId),definition:progress,context:matterContext});
      progressBinding=compilePredicateResponseIdentity(progressEnvelope.statements[0],progress.responseVerification);
      progressResult=await executeRead({operation:"list-progress",role:"progress-records",envelope:progressEnvelope});
      if(!progressResult||progressResult.templateId!==progress.templateId||!exactSchema(progressResult,progress.expectedResponseColumns)||
         !Array.isArray(progressResult.rows)||progressResult.rows.length<1||progressResult.rows.length>500||credentialColumns(progressResult.columns).length)throw new Error();
      verifyPredicateResponseIdentity(progressResult,progressBinding);
      const matches=progressResult.rows.filter(row=>row?.rec_doc===label);
      if(matches.length!==1)throw new Error();
      selectedProgress=matches[0];
      if(directGroup)documentGroup=safeIdentity(selectedProgress[progressGroupSourceColumn]);
      else progressIdentity=safeIdentity(selectedProgress.idx);
    }catch{throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_PROGRESS_REJECTED");}
    finally{matterContext=null;progressEnvelope=null;progressBinding=null;}
    if(!directGroup){
      try{
        intermediateEnvelope=bindTrustedDerivedScalarTemplate({envelope:await loadTemplate(intermediate.templateId),definition:intermediate,value:progressIdentity});
        intermediateBinding=compilePredicateResponseIdentity(intermediateEnvelope.statements[0],intermediate.responseVerification);
        intermediateResult=await executeRead({operation:"list-documents",role:"document-group-record",envelope:intermediateEnvelope});
        if(!intermediateResult||intermediateResult.templateId!==intermediate.templateId||!exactSchema(intermediateResult,intermediate.expectedResponseColumns)||
           !Array.isArray(intermediateResult.rows)||intermediateResult.rows.length!==1||credentialColumns(intermediateResult.columns).length)throw new Error();
        verifyPredicateResponseIdentity(intermediateResult,intermediateBinding);
        if(intermediateResult.rows[0]?.rec_doc!==label)throw new Error();
        documentGroup=safeIdentity(intermediateResult.rows[0]?.idx_parent);
      }catch{throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_GROUP_REJECTED");}
      finally{progressIdentity=null;intermediateEnvelope=null;intermediateBinding=null;}
    }
    selectedProgress=null;progressResult=null;
    try{documentEnvelope=bindTrustedDerivedScalarTemplate({envelope:await loadTemplate(document.templateId),definition:document,value:documentGroup});}
    catch{throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_TEMPLATE_BINDING_REJECTED");}
    try{documentBinding=compileResponsePredicateSet(documentEnvelope.statements[0],document.responsePredicateSetVerification);}
    catch{throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_RESPONSE_POLICY_REJECTED");}
    try{documentResult=await executeRead({operation:"list-documents",role:"progress-document-records",envelope:documentEnvelope});}
    catch{throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_READ_REJECTED");}
    try{
      if(!documentResult||documentResult.templateId!==document.templateId||!exactSchema(documentResult,document.expectedResponseColumns)||
         !Array.isArray(documentResult.rows)||documentResult.rows.length>500||credentialColumns(documentResult.columns).length)throw new Error();
      verifyResponsePredicateSet(documentResult,documentBinding);
      return{matterReference:matter,progressDocument:label,result:{...documentResult,matterReference:matter}};
    }catch{throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_RESULT_REJECTED");}
    finally{documentGroup=null;documentEnvelope=null;documentBinding=null;}
  }

  return Object.freeze({
    async list(input){
      if(!input||Object.keys(input).sort().join(",")!=="matterReference,progressDocument")throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_INPUT_REJECTED");
      let verified;
      try{
        verified=await readVerified(input);
        const projected=projectVerifiedDocumentList(verified.result,{matterReference:verified.matterReference,responseBindingVerified:true,templateId:document.templateId});
        return Object.freeze({...projected,progressDocument:verified.progressDocument});
      }catch(error){if(error instanceof ProgressDocumentLookupError)throw error;throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_RESULT_REJECTED");}
      finally{verified=null;}
    },
    async prepareDownload(input){
      if(!input||Object.keys(input).sort().join(",")!=="expectedFileName,matterReference,position,progressDocument")throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_INPUT_REJECTED");
      let verified,target;
      try{
        verified=await readVerified({matterReference:input.matterReference,progressDocument:input.progressDocument});
        target=resolveVerifiedDocumentDownload(verified.result,{matterReference:verified.matterReference,position:input.position,expectedFileName:input.expectedFileName,responseBindingVerified:true,templateId:document.templateId});
        return createVerifiedDocumentSelection(target);
      }catch(error){if(error instanceof ProgressDocumentLookupError)throw error;throw new ProgressDocumentLookupError("PROGRESS_DOCUMENT_SELECTION_REJECTED");}
      finally{verified=null;target=null;}
    },
  });
}
