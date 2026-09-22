import {diagnoseVerifiedDocumentListEvidence,projectVerifiedDocumentList,resolveVerifiedDocumentDownload} from "./document-list.mjs";
import {createVerifiedDocumentSelection} from "./document-selection-context.mjs";
import {deriveMatterAttachmentListTemplate,selectNoticeAttachmentCandidates,verifyMatterAttachmentList} from "./matter-attachment-source.mjs";
import {normalizeExactMatterReference} from "./matter-reference.mjs";
import {bindMatterIdentityDetailTemplate,bindMatterReferenceSearchTemplate,createMatterIdentityContext,readMatterSearchCandidateCount} from "./parameterized-read-template.mjs";
import {compilePredicateResponseIdentity,verifyPredicateResponseIdentity} from "./response-identity.mjs";

const RELATED_COLUMNS=Object.freeze(["진행수","연차수","신규성수","연구과제수","우선권수","첨부수","업무관리수","청구수","메모수","메일발송수"]);
const PROGRESS_DOCUMENTS=new Map([["의견제출통지서","opinion_submission"],["거절결정서","rejection_decision"]]);

function exactSchema(result,expected){return Array.isArray(result?.columns)&&result.columns.length===expected.length&&expected.every((column,index)=>column===result.columns[index]);}
function optionalText(value,maximum){if(value===undefined)return undefined;if(typeof value!=="string"||!value.length||value!==value.trim()||value.length>maximum||/[\p{Cc}\p{Cs}]/u.test(value))throw new Error("NOTICE_ATTACHMENT_INPUT_REJECTED");return value;}

export class NoticeAttachmentLookupError extends Error{constructor(code){super(code);this.name="NoticeAttachmentLookupError";this.code=code;}}

export function createNoticeAttachmentLookup({countDefinition,searchDefinition,progressDefinition,documentDefinition,relatedCandidate,loadTemplate,executeRead}){
  const count=structuredClone(countDefinition),search=structuredClone(searchDefinition),progress=structuredClone(progressDefinition),document=structuredClone(documentDefinition),relatedSource=structuredClone(relatedCandidate);
  if(typeof loadTemplate!=="function"||typeof executeRead!=="function"||document?.expectedResponseColumns?.length!==27||relatedSource?.templateId!=="matter-detail.related-counts.v1")throw new Error("NOTICE_ATTACHMENT_PROVIDER_REJECTED");
  const related=Object.freeze({templateId:relatedSource.templateId,command:"SELECT",statementCount:1,productionEnabled:true,baseFingerprint:relatedSource.fingerprint,parameterization:Object.freeze({mode:"multi-scalar-equality",source:"verified-search-identity",predicateColumns:Object.freeze(["idx_parent","GRP_KEY","idx_data"]),expectedOccurrenceCounts:Object.freeze({idx_parent:11,GRP_KEY:1,idx_data:1}),sourceTemplateId:search.templateId,sourceColumn:search.responseIdentityColumn})});
  async function readVerified(input){
      const keys=Object.keys(input??{}).sort().join(",");
      if(!["matterReference,progressDocument","matterReference,noticeDate,progressDocument","matterReference,progressDocument,sequence","matterReference,noticeDate,progressDocument,sequence"].includes(keys))throw new NoticeAttachmentLookupError("NOTICE_ATTACHMENT_INPUT_REJECTED");
      let matter,progressDocument,noticeDate,sequence;
      try{
        matter=normalizeExactMatterReference(input.matterReference);progressDocument=optionalText(input.progressDocument,64);noticeDate=optionalText(input.noticeDate,10);sequence=optionalText(input.sequence,128);
        if(!PROGRESS_DOCUMENTS.has(progressDocument)||(noticeDate!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(noticeDate)))throw new Error();
      }catch{throw new NoticeAttachmentLookupError("NOTICE_ATTACHMENT_INPUT_REJECTED");}
      let countBase,searchBase,progressBase,relatedBase,broad,context,selectedProgress,attachmentResult,attachmentCount;
      try{
        [countBase,searchBase,progressBase,relatedBase]=await Promise.all([count.templateId,search.templateId,progress.templateId,related.templateId].map(id=>loadTemplate(id)));
        broad=deriveMatterAttachmentListTemplate({relatedEnvelope:relatedBase,relatedCandidate:relatedSource,expectedResponseColumns:document.expectedResponseColumns});
        const countEnvelope=bindMatterReferenceSearchTemplate({envelope:countBase,definition:count,matterReference:matter});
        const countResult=await executeRead({operation:"search-matter",role:"count-results",envelope:countEnvelope});
        const candidateCount=readMatterSearchCandidateCount({result:countResult,definition:count});
        const searchEnvelope=bindMatterReferenceSearchTemplate({envelope:searchBase,definition:search,matterReference:matter});
        const searchResult=await executeRead({operation:"search-matter",role:"fetch-result-rows",envelope:searchEnvelope});
        if(!Array.isArray(searchResult?.rows)||searchResult.rows.length!==candidateCount)throw new Error();
        context=createMatterIdentityContext({matterReference:matter,searchResult,definition:search});
        const progressEnvelope=bindMatterIdentityDetailTemplate({envelope:progressBase,definition:progress,context});
        const progressBinding=compilePredicateResponseIdentity(progressEnvelope.statements[0],progress.responseVerification);
        const progressResult=await executeRead({operation:"list-progress",role:"progress-records",envelope:progressEnvelope});
        if(!exactSchema(progressResult,progress.expectedResponseColumns)||progressResult.rows.length<1||progressResult.rows.length>500)throw new Error();
        verifyPredicateResponseIdentity(progressResult,progressBinding);
        const matches=progressResult.rows.filter(row=>row?.rec_doc===progressDocument&&(noticeDate===undefined||row?.d_noti===noticeDate)&&(sequence===undefined||row?.no_rec===sequence));
        if(matches.length!==1)throw new Error();selectedProgress=matches[0];
        const relatedEnvelope=bindMatterIdentityDetailTemplate({envelope:relatedBase,definition:related,context});
        const relatedResult=await executeRead({operation:"get-matter-detail",role:"attachment-count",envelope:relatedEnvelope});
        if(!exactSchema(relatedResult,RELATED_COLUMNS)||relatedResult.rows.length!==1||RELATED_COLUMNS.some(column=>!/^(?:0|[1-9]\d*)$/.test(relatedResult.rows[0]?.[column]??"")))throw new Error();
        attachmentCount=Number(relatedResult.rows[0]["첨부수"]);if(attachmentCount>500)throw new Error();
        const attachmentEnvelope=bindMatterIdentityDetailTemplate({envelope:broad.envelope,definition:broad.definition,context});
        attachmentResult=await executeRead({operation:"list-documents",role:"matter-attachment-records",envelope:attachmentEnvelope});
        verifyMatterAttachmentList({result:attachmentResult,compiledEnvelope:attachmentEnvelope,definition:broad.definition,divisionLike:broad.divisionLike,expectedCount:attachmentCount});
        diagnoseVerifiedDocumentListEvidence({...attachmentResult,matterReference:matter},{matterReference:matter,templateId:broad.definition.templateId});
        const documents=projectVerifiedDocumentList({...attachmentResult,matterReference:matter},{matterReference:matter,responseBindingVerified:true,templateId:broad.definition.templateId});
        const items=selectNoticeAttachmentCandidates({items:documents.items,matterReference:matter,progressDocument,noticeDate:selectedProgress.d_noti||undefined});
        return{matterReference:matter,noticeKind:PROGRESS_DOCUMENTS.get(progressDocument),progressDocument,noticeDate:selectedProgress.d_noti||null,dueDate:selectedProgress.d_due||null,sequence:selectedProgress.no_rec||null,aggregateAttachmentCount:attachmentCount,count:items.length,items,attachmentResult:{...attachmentResult,matterReference:matter},templateId:broad.definition.templateId};
      }catch(error){if(error instanceof NoticeAttachmentLookupError)throw error;throw new NoticeAttachmentLookupError("NOTICE_ATTACHMENT_LOOKUP_REJECTED");}
      finally{countBase=null;searchBase=null;progressBase=null;relatedBase=null;broad=null;context=null;selectedProgress=null;attachmentResult=null;attachmentCount=null;}
  }
  return Object.freeze({
    async list(input){
      let verified;
      try{
        verified=await readVerified(input);
        return Object.freeze({matterReference:verified.matterReference,noticeKind:verified.noticeKind,progressDocument:verified.progressDocument,noticeDate:verified.noticeDate,dueDate:verified.dueDate,sequence:verified.sequence,aggregateAttachmentCount:verified.aggregateAttachmentCount,count:verified.count,items:verified.items});
      }finally{verified=null;}
    },
    async preparePackage(input){
      const keys=Object.keys(input??{}).sort().join(",");
      if(!["expectedItems,matterReference,noticeDate,progressDocument","expectedItems,matterReference,noticeDate,progressDocument,sequence"].includes(keys)||!Array.isArray(input.expectedItems)||input.expectedItems.length<1||input.expectedItems.length>500)throw new NoticeAttachmentLookupError("NOTICE_ATTACHMENT_INPUT_REJECTED");
      let verified,expected,selections;
      try{
        expected=input.expectedItems.map(item=>({position:item?.position,documentName:item?.documentName??null,registeredAt:item?.registeredAt??null,fileName:item?.fileName,fileSizeBytes:item?.fileSizeBytes}));
        if(expected.some(item=>!Number.isInteger(item.position)||item.position<1||typeof item.fileName!=="string"||!Number.isSafeInteger(item.fileSizeBytes)||item.fileSizeBytes<0))throw new Error();
        verified=await readVerified(Object.fromEntries(Object.entries(input).filter(([key])=>key!=="expectedItems")));
        if(JSON.stringify(verified.items)!==JSON.stringify(expected))throw new Error();
        selections=verified.items.map(item=>createVerifiedDocumentSelection(resolveVerifiedDocumentDownload(verified.attachmentResult,{matterReference:verified.matterReference,position:item.position,expectedFileName:item.fileName,responseBindingVerified:true,templateId:verified.templateId})));
        return Object.freeze({matterReference:verified.matterReference,noticeKind:verified.noticeKind,progressDocument:verified.progressDocument,noticeDate:verified.noticeDate,dueDate:verified.dueDate,sequence:verified.sequence,aggregateAttachmentCount:verified.aggregateAttachmentCount,count:verified.count,items:verified.items,selections:Object.freeze(selections)});
      }catch(error){if(error instanceof NoticeAttachmentLookupError)throw error;throw new NoticeAttachmentLookupError("NOTICE_ATTACHMENT_SELECTION_REJECTED");}
      finally{verified=null;expected=null;selections=null;}
    },
  });
}
