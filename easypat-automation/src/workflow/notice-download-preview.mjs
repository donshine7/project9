import {createHash} from "node:crypto";
import {normalizeExactMatterReference} from "../protocol/matter-reference.mjs";

const REFERENCE=/(?:PPT|PT|P|T|D)\d{3,12}(?:-[A-Z0-9]+(?:\([A-Z0-9]+\))?)*/giu;
const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;

function isoDate(value){
  if(typeof value!=="string")return null;
  const match=/^(\d{4})[-.](\d{2})[-.](\d{2})$/.exec(value.trim());
  return match?`${match[1]}-${match[2]}-${match[3]}`:null;
}

function references(record){
  const found=new Set();
  for(const value of [record?.subject,record?.body]){
    if(typeof value!=="string")continue;
    for(const match of value.matchAll(REFERENCE)){try{found.add(normalizeExactMatterReference(match[0]));}catch{}}
  }
  return [...found];
}

function classifyMail(record){
  const subject=typeof record?.subject==="string"?record.subject:"",body=typeof record?.body==="string"?record.body:"",refs=references(record);
  if(refs.length!==1)return null;
  let noticeKind=null,role=null;
  if(/^\[업무요청\]/u.test(subject)&&/의견제출통지서/u.test(subject+body)){noticeKind="opinion_submission";role="work_request";}
  else if(/^\[업무요청\]/u.test(subject)&&/거절결정서/u.test(subject+body)){noticeKind="rejection_decision";role="work_request";}
  else if(/^\[EASYPAT_S\]/u.test(subject)&&/업무구분\s*:\s*OA/u.test(body)){role="assignment";}
  else return null;
  const dueMatch=/대응기한\s*:\s*(\d{4}[-.]\d{2}[-.]\d{2})/u.exec(body);
  return{matterReference:refs[0],noticeKind,role,dueDate:dueMatch?isoDate(dueMatch[1]):null};
}

function stableMailKey(record){
  for(const value of [record?.messageId,record?.internetMessageId,record?.entryId])if(typeof value==="string"&&value.trim())return value.trim().toLowerCase();
  const material=JSON.stringify([record?.subject??"",record?.received??record?.mailAt??"",record?.body??""]);
  return`hash:${createHash("sha256").update(material).digest("hex")}`;
}

function noticeKey(value){
  const basis=value.sequence?"progress_sequence_and_notice_date":"notice_date_provisional";
  const material=["notice-v1",value.matterReference,value.noticeKind,value.sequence??"",value.noticeDate].join("|");
  return{key:`notice_${createHash("sha256").update(material).digest("hex")}`,basis};
}

function kindSequence(notice,progressItems){
  const progressDocument=notice.noticeKind==="opinion_submission"?"의견제출통지서":notice.noticeKind==="rejection_decision"?"거절결정서":null;
  if(progressDocument===null)return null;
  const events=[],seen=new Set();
  for(const item of Array.isArray(progressItems)?progressItems:[]){
    if(item?.document!==progressDocument||!ISO_DATE.test(item?.noticeDate??""))continue;
    const sequence=typeof item.sequence==="string"&&item.sequence.length?item.sequence:null;
    const key=sequence?`sequence:${sequence}|date:${item.noticeDate}`:`date:${item.noticeDate}|due:${item.dueDate??""}`;
    if(seen.has(key))continue;seen.add(key);events.push({sequence,noticeDate:item.noticeDate});
  }
  events.sort((left,right)=>left.noticeDate.localeCompare(right.noticeDate)||(Number(left.sequence)-Number(right.sequence)||String(left.sequence??"").localeCompare(String(right.sequence??""))));
  const matches=events.map((event,index)=>({event,index})).filter(({event})=>event.noticeDate===notice.noticeDate&&(notice.sequence?event.sequence===notice.sequence:true));
  return matches.length===1?matches[0].index+1:null;
}

function expectedFileName(notice,sequence){
  if(notice.noticeKind==="opinion_submission")return`[${notice.matterReference}] ${sequence}OA (${notice.noticeDate})(${notice.dueDate}).zip`;
  return`[${notice.matterReference}] 거절결정 (${sequence}차)(${notice.noticeDate})(${notice.dueDate}).zip`;
}

function normalizedLedger(ledger){
  const set=value=>new Set((Array.isArray(value)?value:[]).filter(item=>typeof item==="string").map(item=>item.toLowerCase()));
  return{noticeKeys:set(ledger?.noticeKeys),completedNoticeKeys:set(ledger?.completedNoticeKeys),packageFileNames:set(ledger?.packageFileNames)};
}

export function buildNoticeDownloadPreview({mailRecords,notices,progressByMatter={},ledger={}}){
  if(!Array.isArray(mailRecords)||!Array.isArray(notices)||mailRecords.length>5000||notices.length>500)throw new Error("NOTICE_PREVIEW_INPUT_REJECTED");
  const seenMail=new Set(),relevant=[];
  for(const record of mailRecords){const key=stableMailKey(record);if(seenMail.has(key))continue;seenMail.add(key);const parsed=classifyMail(record);if(parsed)relevant.push(parsed);}
  const requests=new Map(),assignments=new Map();
  for(const mail of relevant){
    if(mail.role==="assignment"){const list=assignments.get(mail.matterReference)??[];list.push(mail);assignments.set(mail.matterReference,list);continue;}
    const key=`${mail.matterReference}|${mail.noticeKind}`,list=requests.get(key)??[];list.push(mail);requests.set(key,list);
  }
  const groupsPerMatter=new Map();for(const key of requests.keys()){const matter=key.slice(0,key.indexOf("|"));groupsPerMatter.set(matter,(groupsPerMatter.get(matter)??0)+1);}
  const safeLedger=normalizedLedger(ledger),items=[];
  for(const [groupKey,requestMails] of [...requests].sort(([left],[right])=>left.localeCompare(right))){
    const [matterReference,noticeKind]=groupKey.split("|"),linked=[...requestMails];
    if(groupsPerMatter.get(matterReference)===1)linked.push(...(assignments.get(matterReference)??[]));
    const matching=notices.filter(item=>item?.matterReference===matterReference&&item?.noticeKind===noticeKind),holdReasons=[];
    if(matching.length!==1){holdReasons.push(matching.length?"ambiguous_easypat_notice":"missing_easypat_notice");items.push({matterReference,noticeKind,status:"held",holdReasons,linkedMailCount:linked.length});continue;}
    const notice=matching[0],noticeDate=isoDate(notice.noticeDate),dueDate=isoDate(notice.dueDate);
    if(!noticeDate)holdReasons.push("missing_notice_date");if(!dueDate)holdReasons.push("missing_due_date");
    const mailDueDates=[...new Set(requestMails.map(mail=>mail.dueDate).filter(Boolean))];
    if(mailDueDates.length!==1)holdReasons.push(mailDueDates.length?"conflicting_mail_due_dates":"missing_mail_due_date");
    else if(dueDate&&mailDueDates[0]!==dueDate)holdReasons.push("mail_easypat_due_date_mismatch");
    if(!Number.isSafeInteger(notice.count)||notice.count<1||!Number.isSafeInteger(notice.aggregateAttachmentCount)||notice.aggregateAttachmentCount<notice.count)holdReasons.push("invalid_attachment_package");
    const sequence=kindSequence(notice,progressByMatter[matterReference]);
    if(sequence===null)holdReasons.push(noticeKind==="opinion_submission"?"oa_sequence_unresolved":"rejection_sequence_unresolved");
    const identity=noticeDate?noticeKey({...notice,matterReference,noticeKind,noticeDate}):null;
    const fileName=noticeDate&&dueDate&&sequence!==null?expectedFileName({...notice,matterReference,noticeKind,noticeDate,dueDate},sequence):null;
    let ledgerDisposition="new";
    if(identity&&safeLedger.completedNoticeKeys.has(identity.key.toLowerCase()))ledgerDisposition="already_completed";
    else if(fileName&&safeLedger.packageFileNames.has(fileName.toLowerCase()))ledgerDisposition="filename_conflict";
    else if(identity&&safeLedger.noticeKeys.has(identity.key.toLowerCase()))ledgerDisposition="resume_existing";
    if(ledgerDisposition==="filename_conflict")holdReasons.push("destination_filename_conflict");
    const status=ledgerDisposition==="already_completed"?"duplicate":holdReasons.length?"held":"ready";
    items.push({noticeKey:identity?.key??null,identityBasis:identity?.basis??null,matterReference,noticeKind,oaSequence:noticeKind==="opinion_submission"?sequence:null,rejectionSequence:noticeKind==="rejection_decision"?sequence:null,noticeDate,dueDate,expectedFileName:fileName,linkedMailCount:linked.length,mailRoles:[...new Set(linked.map(mail=>mail.role))].sort(),attachmentCount:Number.isSafeInteger(notice.count)?notice.count:null,aggregateAttachmentCount:Number.isSafeInteger(notice.aggregateAttachmentCount)?notice.aggregateAttachmentCount:null,ledgerDisposition,status,holdReasons});
  }
  return Object.freeze({status:"dry-run",mailRecordCount:mailRecords.length,uniqueRelevantMailCount:relevant.length,candidateCount:items.length,readyCount:items.filter(item=>item.status==="ready").length,heldCount:items.filter(item=>item.status==="held").length,duplicateCount:items.filter(item=>item.status==="duplicate").length,totalAttachmentCount:items.filter(item=>item.status==="ready").reduce((sum,item)=>sum+(item.attachmentCount??0),0),items:Object.freeze(items.map(item=>Object.freeze(item)))});
}
