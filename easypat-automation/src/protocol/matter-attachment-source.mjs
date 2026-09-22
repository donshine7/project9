import {credentialColumns} from "./response-schema.mjs";
import {compileResponsePredicateSet,verifyResponsePredicateSet} from "./response-predicate-set.mjs";
import {createReadOnlyBatch} from "./read-only-guard.mjs";
import {fingerprintEnvelope} from "./template-fingerprint.mjs";

const TEMPLATE_ID="matter-detail.attachments.all.v1";
const SQL_LITERAL="(?:N?'(?:[^']|'')*'|(?:0|[1-9]\\d*))";
const ATTACHMENT_COUNT=new RegExp(
  `\\(\\s*SELECT\\s+count\\s*\\(\\s*\\*\\s*\\)\\s+FROM\\s+opms_attach\\s+WHERE\\s+DELETEFLG\\s*=\\s*(${SQL_LITERAL})\\s+AND\\s+DIV\\s+LIKE\\s+(${SQL_LITERAL})\\s+AND\\s+GRP_KEY\\s*=\\s*(${SQL_LITERAL})\\s*\\)\\s+AS\\s+`,
  "iu",
);

function literalValue(raw){
  if(/^N?'/i.test(raw))return raw.replace(/^N?'/i,"").slice(0,-1).replaceAll("''", "'");
  if(/^(?:0|[1-9]\d*)$/.test(raw))return raw;
  throw new Error("MATTER_ATTACHMENT_SOURCE_REJECTED");
}

function likePattern(raw){
  const value=literalValue(raw);
  if(!value.length||value.length>128||/[\p{Cc}\p{Cs}\[\]\\]/u.test(value))throw new Error("MATTER_ATTACHMENT_SOURCE_REJECTED");
  let pattern="^";
  for(const character of value){
    if(character==="%")pattern+=".*";
    else if(character==="_")pattern+=".";
    else pattern+=character.replace(/[.*+?^${}()|]/g,"\\$&");
  }
  return new RegExp(pattern+"$","iu");
}

export function deriveMatterAttachmentListTemplate({relatedEnvelope,relatedCandidate,expectedResponseColumns}){
  if(relatedCandidate?.templateId!=="matter-detail.related-counts.v1"||relatedCandidate.command!=="SELECT"||relatedCandidate.statementCount!==1||
     relatedEnvelope?.templateId!==relatedCandidate.templateId||relatedEnvelope.command!=="SELECT"||relatedEnvelope.statements?.length!==1||
     fingerprintEnvelope(relatedEnvelope)!==relatedCandidate.fingerprint||!Array.isArray(expectedResponseColumns)||expectedResponseColumns.length!==27){
    throw new Error("MATTER_ATTACHMENT_SOURCE_REJECTED");
  }
  createReadOnlyBatch([relatedEnvelope]);
  const match=ATTACHMENT_COUNT.exec(relatedEnvelope.statements[0]);
  if(!match)throw new Error("MATTER_ATTACHMENT_SOURCE_REJECTED");
  const [,deleteFlag,divisionLike,groupKey]=match;
  const statement=`SELECT * FROM opms_attach WHERE DELETEFLG = ${deleteFlag} AND DIV LIKE ${divisionLike} AND GRP_KEY = ${groupKey} ORDER BY IDX`;
  const envelope=Object.freeze({templateId:TEMPLATE_ID,command:"SELECT",statements:Object.freeze([statement])});
  createReadOnlyBatch([envelope]);
  const definition=Object.freeze({
    templateId:TEMPLATE_ID,
    command:"SELECT",
    statementCount:1,
    productionEnabled:false,
    baseFingerprint:fingerprintEnvelope(envelope),
    parameterization:Object.freeze({mode:"single-scalar-equality",source:"verified-search-identity",predicateColumn:"GRP_KEY",sourceTemplateId:"matter-search.exact-result.v1",sourceColumn:"idx"}),
    responsePredicateSetVerification:Object.freeze({mode:"statement-literals-all-rows",columns:Object.freeze(["DELETEFLG","GRP_KEY"])}),
    expectedResponseColumns:Object.freeze([...expectedResponseColumns]),
  });
  return Object.freeze({envelope,definition,divisionLike:likePattern(divisionLike)});
}

export function verifyMatterAttachmentList({result,compiledEnvelope,definition,divisionLike,expectedCount}){
  if(result?.templateId!==TEMPLATE_ID||compiledEnvelope?.templateId!==TEMPLATE_ID||definition?.templateId!==TEMPLATE_ID||
     !Array.isArray(result.columns)||!Array.isArray(result.rows)||!Number.isSafeInteger(expectedCount)||expectedCount<0||expectedCount>500||
     result.rows.length!==expectedCount||result.columns.length!==definition.expectedResponseColumns.length||
     definition.expectedResponseColumns.some((column,index)=>column!==result.columns[index])||credentialColumns(result.columns).length||
     !(divisionLike instanceof RegExp))throw new Error("MATTER_ATTACHMENT_RESULT_REJECTED");
  const binding=compileResponsePredicateSet(compiledEnvelope.statements[0],definition.responsePredicateSetVerification);
  verifyResponsePredicateSet(result,binding);
  if(result.rows.some(row=>typeof row?.DIV!=="string"||!divisionLike.test(row.DIV)))throw new Error("MATTER_ATTACHMENT_RESULT_REJECTED");
  return Object.freeze({verified:true,count:result.rows.length});
}

function timestamp(value){
  const match=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value??"");
  return match?Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4]),Number(match[5]),Number(match[6]),Number((match[7]??"").padEnd(3,"0"))):null;
}

export function selectNoticeAttachmentCandidates({items,matterReference,progressDocument,noticeDate}){
  if(!Array.isArray(items)||!items.length||items.length>500||typeof matterReference!=="string"||typeof progressDocument!=="string"||!progressDocument.length||
     noticeDate!==undefined&&(typeof noticeDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(noticeDate)))throw new Error("NOTICE_ATTACHMENT_SELECTION_REJECTED");
  const reference=matterReference.toUpperCase(),safeItems=items.map((item,index)=>{
    if(item?.position!==index+1||typeof item.fileName!=="string"||!item.fileName.length||typeof item.documentName!=="string"&&item.documentName!==null)throw new Error("NOTICE_ATTACHMENT_SELECTION_REJECTED");
    return{item,time:timestamp(item.registeredAt)};
  });
  const allAnchors=safeItems.filter(({item,time})=>time!==null&&item.fileName.toUpperCase().includes(reference)&&item.fileName.endsWith(`${progressDocument}.pdf`));
  let anchors=allAnchors;
  if(noticeDate!==undefined){
    const noticeDay=Date.parse(`${noticeDate}T00:00:00Z`),ranked=allAnchors.map(candidate=>({candidate,dayOffset:(Date.parse(`${candidate.item.registeredAt.slice(0,10)}T00:00:00Z`)-noticeDay)/86400000})).filter(value=>Number.isInteger(value.dayOffset)&&value.dayOffset>=0&&value.dayOffset<=7);
    if(ranked.length){const nearest=Math.min(...ranked.map(value=>value.dayOffset));anchors=ranked.filter(value=>value.dayOffset===nearest).map(value=>value.candidate);}else anchors=[];
  }
  if(anchors.length!==1)throw new Error("NOTICE_ATTACHMENT_SELECTION_REJECTED");
  const anchor=anchors[0],explicit=safeItems.filter(({item,time})=>time!==null&&Math.abs(time-anchor.time)<=10*60*1000&&item.fileName.toUpperCase().includes(reference)&&item.fileName.includes(progressDocument));
  const headers=safeItems.filter(({item,time})=>time!==null&&time<=anchor.time&&anchor.time-time<=2*60*60*1000&&item.documentName==="HDR문서"&&/\.zip$/i.test(item.fileName));
  if(headers.length<1)throw new Error("NOTICE_ATTACHMENT_SELECTION_REJECTED");
  const header=headers.reduce((latest,current)=>current.time>latest.time?current:latest);
  const official=safeItems.filter(({item,time})=>time!==null&&Math.abs(time-anchor.time)<=10*60*1000&&/\.fin$/i.test(item.fileName));
  const selected=[header,...explicit,...official],lastPosition=Math.max(...selected.map(({item})=>item.position));
  if(lastPosition<header.item.position)throw new Error("NOTICE_ATTACHMENT_SELECTION_REJECTED");
  const batch=safeItems.slice(header.item.position-1,lastPosition);
  if(batch.length!==lastPosition-header.item.position+1||batch.some(({time})=>time===null||time<header.time||time-anchor.time>10*60*1000))throw new Error("NOTICE_ATTACHMENT_SELECTION_REJECTED");
  return Object.freeze(batch.map(({item})=>item));
}
