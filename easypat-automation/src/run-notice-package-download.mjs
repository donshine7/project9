import {createEasyPatRuntime} from "./runtime.mjs";
import {beginNoticeDownload,completeNoticeDownload,failNoticeDownload} from "./workflow/notice-download-ledger.mjs";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";

function input(){const matterIndex=process.argv.indexOf("--matter-reference"),sequenceIndex=process.argv.indexOf("--oa-sequence");if(matterIndex<0||sequenceIndex<0)throw new Error("NOTICE_DOWNLOAD_INPUT_REJECTED");const matterReference=normalizeExactMatterReference(process.argv[matterIndex+1]),oaSequence=Number(process.argv[sequenceIndex+1]);if(!Number.isSafeInteger(oaSequence)||oaSequence<1||oaSequence>50)throw new Error("NOTICE_DOWNLOAD_INPUT_REJECTED");return{matterReference,oaSequence};}
function oaEvents(items){const seen=new Set(),events=[];for(const item of items){if(item?.document!=="의견제출통지서"||!/^\d{4}-\d{2}-\d{2}$/.test(item?.noticeDate??""))continue;const key=`${item.sequence??""}|${item.noticeDate}`;if(seen.has(key))continue;seen.add(key);events.push(item);}return events.sort((left,right)=>left.noticeDate.localeCompare(right.noticeDate)||(Number(left.sequence)-Number(right.sequence)||String(left.sequence??"").localeCompare(String(right.sequence??""))));}

let ledgerContext;
try{
  const target=input(),runtime=createEasyPatRuntime(),progress=await runtime.listProgress({matterReference:target.matterReference});
  const event=oaEvents(progress.items)[target.oaSequence-1];if(!event)throw new Error("OA_SEQUENCE_NOT_FOUND");
  const listInput={matterReference:target.matterReference,progressDocument:"의견제출통지서",noticeDate:event.noticeDate};if(event.sequence)listInput.sequence=event.sequence;
  const notice=await runtime.listNoticeAttachments(listInput);if(!notice.dueDate||notice.count<1)throw new Error("NOTICE_DOWNLOAD_TARGET_REJECTED");
  const expectedFileName=`[${target.matterReference}] ${target.oaSequence}OA (${notice.noticeDate})(${notice.dueDate}).zip`;
  ledgerContext=beginNoticeDownload({matterReference:target.matterReference,noticeKind:notice.noticeKind,oaSequence:target.oaSequence,noticeDate:notice.noticeDate,dueDate:notice.dueDate,sequence:notice.sequence,aggregateAttachmentCount:notice.aggregateAttachmentCount,expectedFileName,items:notice.items});
  if(ledgerContext.duplicate){console.log(JSON.stringify({status:"duplicate",matterReference:target.matterReference,oaSequence:target.oaSequence,noticeDate:notice.noticeDate,dueDate:notice.dueDate,expectedFileName,noticeKey:ledgerContext.noticeKey}));process.exit(0);}
  const result=await runtime.publishNoticePackage({matterReference:target.matterReference,progressDocument:"의견제출통지서",oaSequence:target.oaSequence,noticeDate:notice.noticeDate,dueDate:notice.dueDate,sequence:notice.sequence,expectedItems:notice.items});
  const ledger=completeNoticeDownload(ledgerContext,result);
  console.log(JSON.stringify({status:"published",matterReference:result.matterReference,oaSequence:result.oaSequence,noticeDate:result.noticeDate,dueDate:result.dueDate,expectedFileName:result.expectedFileName,destinationPath:result.destinationPath,stagingPath:result.stagingPath,itemCount:result.itemCount,fileSizeBytes:result.fileSizeBytes,sha256:result.sha256,noticeKey:ledger.noticeKey,packageVersion:ledger.packageVersion,overwritten:false,automaticRetryPerformed:false,serverMutationPerformed:false}));
}catch(error){const code=/^[A-Z0-9_-]+$/.test(error?.code??error?.message??"")?(error.code??error.message):"NOTICE_DOWNLOAD_FAILED",contentType=/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(error?.details?.contentType??"")?error.details.contentType:undefined;try{failNoticeDownload(ledgerContext,code);}catch{}console.error(JSON.stringify({status:"failed",code,...(contentType?{contentType}:{})}));process.exitCode=1;}
