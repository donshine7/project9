import {existsSync} from "node:fs";
import {readdir,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const serverEntry=fileURLToPath(new URL("./mcp-server.mjs",import.meta.url));
const destinationPath="C:\\Users\\donsh\\OneDrive\\Desktop\\ONEDRIVE\\Desktop\\[상상] 업무분류\\0-0. intake";
const dbPath=process.env.SSPAT_WORK_DB_PATH?path.resolve(process.env.SSPAT_WORK_DB_PATH):path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local"),"SSPAT","work-management","sspat-work.db");

function input(){
  const matterIndex=process.argv.indexOf("--matter-reference"),sequenceIndex=process.argv.indexOf("--oa-sequence");
  if(matterIndex<0||sequenceIndex<0)throw new Error("INSPECTION_INPUT_REJECTED");
  const matterReference=normalizeExactMatterReference(process.argv[matterIndex+1]),oaSequence=Number(process.argv[sequenceIndex+1]);
  if(!Number.isSafeInteger(oaSequence)||oaSequence<1||oaSequence>50)throw new Error("INSPECTION_INPUT_REJECTED");
  return{matterReference,oaSequence};
}

function ledgerState(matterReference){
  const result={databasePresent:existsSync(dbPath),matterPresent:false,noticeCount:0,publishedPackageCount:0};
  if(!result.databasePresent)return result;
  let db;
  try{
    db=new DatabaseSync(dbPath,{readOnly:true});
    const matter=db.prepare("SELECT id FROM matter WHERE our_ref=? COLLATE NOCASE AND archived_at IS NULL").get(matterReference);
    result.matterPresent=Boolean(matter);
    if(matter&&db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notice'").get()){
      result.noticeCount=Number(db.prepare("SELECT COUNT(*) AS n FROM notice WHERE matter_id=?").get(matter.id).n);
      result.publishedPackageCount=Number(db.prepare("SELECT COUNT(*) AS n FROM download_package p JOIN notice n ON n.id=p.notice_id WHERE n.matter_id=?").get(matter.id).n);
    }
    return result;
  }finally{try{db?.close();}catch{}}
}

let client;
try{
  const target=input();
  const destination=await stat(destinationPath);if(!destination.isDirectory())throw new Error("DESTINATION_NOT_DIRECTORY");
  client=new Client({name:"easypat-notice-target-inspector",version:"1.0.0"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:projectRoot,stderr:"pipe"}));
  const progressResponse=await client.callTool({name:"easypat_list_progress",arguments:{matterReference:target.matterReference}});
  const progress=progressResponse.structuredContent;
  if(progressResponse.isError||progress?.matterReference!==target.matterReference||!Array.isArray(progress.items))throw new Error("PROGRESS_RESULT_REJECTED");
  const events=progress.items.filter(item=>item?.document==="의견제출통지서"&&/^\d{4}-\d{2}-\d{2}$/.test(item?.noticeDate??""));
  events.sort((left,right)=>left.noticeDate.localeCompare(right.noticeDate)||(Number(left.sequence)-Number(right.sequence)||String(left.sequence??"").localeCompare(String(right.sequence??""))));
  const selected=events[target.oaSequence-1];if(!selected)throw new Error("OA_SEQUENCE_NOT_FOUND");
  const args={matterReference:target.matterReference,progressDocument:"의견제출통지서",noticeDate:selected.noticeDate};
  if(selected.sequence)args.sequence=selected.sequence;
  const noticeResponse=await client.callTool({name:"easypat_list_notice_attachments",arguments:args});
  const notice=noticeResponse.structuredContent;
  if(noticeResponse.isError||notice?.matterReference!==target.matterReference||notice?.noticeDate!==selected.noticeDate||notice?.noticeKind!=="opinion_submission")throw new Error("NOTICE_RESULT_REJECTED");
  const expectedFileName=`[${target.matterReference}] ${target.oaSequence}OA (${notice.noticeDate})(${notice.dueDate}).zip`;
  const destinationFiles=await readdir(destinationPath,{withFileTypes:true});
  const output={status:"ready",matterReference:target.matterReference,oaSequence:target.oaSequence,noticeDate:notice.noticeDate,dueDate:notice.dueDate,progressSequence:notice.sequence,aggregateAttachmentCount:notice.aggregateAttachmentCount,attachmentCount:notice.count,items:notice.items,expectedFileName,destinationConflict:destinationFiles.some(entry=>entry.isFile()&&entry.name.toLocaleLowerCase("ko-KR")===expectedFileName.toLocaleLowerCase("ko-KR")),ledger:ledgerState(target.matterReference)};
  console.log(JSON.stringify(output));
}catch(error){console.error(JSON.stringify({status:"failed",code:/^[A-Z0-9_-]+$/.test(error?.message??"")?error.message:"NOTICE_TARGET_INSPECTION_REJECTED"}));process.exitCode=1;}
finally{try{await client?.close();}catch{}}
