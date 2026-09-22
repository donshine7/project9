import {existsSync} from "node:fs";
import {readFile,readdir,stat,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {buildNoticeDownloadPreview} from "./workflow/notice-download-preview.mjs";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const workspaceRoot=path.resolve(projectRoot,"..");
const serverEntry=fileURLToPath(new URL("./mcp-server.mjs",import.meta.url));
const snapshotPath=path.join(workspaceRoot,".analysis-private","oa-download-planning-20260918","outlook-snapshot.json");
const previewPath=path.join(workspaceRoot,".analysis-private","oa-download-planning-20260918","notice-download-preview.json");
const destinationPath="C:\\Users\\donsh\\OneDrive\\Desktop\\ONEDRIVE\\Desktop\\[상상] 업무분류\\0-0. intake";
const targets=Object.freeze([
  {matterReference:"P261048",noticeDate:"2026-09-09"},
  {matterReference:"P261315",noticeDate:"2026-09-10"},
  {matterReference:"P261487",noticeDate:"2026-09-11"},
  {matterReference:"P261489",noticeDate:"2026-09-09"},
  {matterReference:"P261610",noticeDate:"2026-09-09"},
]);

function readLedger(){
  const result={noticeKeys:[],completedNoticeKeys:[],packageFileNames:[],tablePresent:false};
  const dbPath=process.env.SSPAT_WORK_DB_PATH?path.resolve(process.env.SSPAT_WORK_DB_PATH):path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local"),"SSPAT","work-management","sspat-work.db");
  if(!existsSync(dbPath))return result;
  let db;
  try{
    db=new DatabaseSync(dbPath,{readOnly:true});
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notice'").get())return result;
    result.tablePresent=true;
    result.noticeKeys=db.prepare("SELECT notice_key FROM notice").all().map(row=>row.notice_key);
    result.completedNoticeKeys=db.prepare("SELECT notice_key FROM notice WHERE status='published'").all().map(row=>row.notice_key);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='download_package'").get())result.packageFileNames=db.prepare("SELECT file_name FROM download_package").all().map(row=>row.file_name);
    return result;
  }finally{try{db?.close();}catch{}}
}

let client,stage="preflight",mcpCallCount=0;
try{
  const destination=await stat(destinationPath);if(!destination.isDirectory())throw new Error("DESTINATION_NOT_DIRECTORY");
  const destinationFiles=(await readdir(destinationPath,{withFileTypes:true})).filter(entry=>entry.isFile()&&/\.zip$/i.test(entry.name)).map(entry=>entry.name);
  const snapshot=JSON.parse(await readFile(snapshotPath,"utf8"));if(!Array.isArray(snapshot.records)||snapshot.records.length!==10)throw new Error("MAIL_SNAPSHOT_REJECTED");
  const ledger=readLedger();ledger.packageFileNames.push(...destinationFiles);
  stage="mcp-connect";client=new Client({name:"easypat-notice-preview-live-validator",version:"1.0.0"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:projectRoot,stderr:"pipe"}));
  const tools=await client.listTools();if(tools.tools.length!==8||!["easypat_list_notice_attachments","easypat_list_progress"].every(name=>tools.tools.some(tool=>tool.name===name)))throw new Error("MCP_TOOL_INVENTORY_REJECTED");
  const notices=[],progressByMatter={};
  for(const target of targets){
    stage=`mcp-notice-${target.matterReference}`;
    const noticeResponse=await client.callTool({name:"easypat_list_notice_attachments",arguments:{matterReference:target.matterReference,progressDocument:"의견제출통지서",noticeDate:target.noticeDate}});mcpCallCount++;
    if(noticeResponse.isError||noticeResponse.structuredContent?.matterReference!==target.matterReference||noticeResponse.structuredContent?.noticeDate!==target.noticeDate)throw new Error("MCP_NOTICE_RESULT_REJECTED");
    notices.push(noticeResponse.structuredContent);
    stage=`mcp-progress-${target.matterReference}`;
    const progressResponse=await client.callTool({name:"easypat_list_progress",arguments:{matterReference:target.matterReference}});mcpCallCount++;
    if(progressResponse.isError||progressResponse.structuredContent?.matterReference!==target.matterReference||!Array.isArray(progressResponse.structuredContent?.items))throw new Error("MCP_PROGRESS_RESULT_REJECTED");
    progressByMatter[target.matterReference]=progressResponse.structuredContent.items;
  }
  stage="preview";
  const preview=buildNoticeDownloadPreview({mailRecords:snapshot.records,notices,progressByMatter,ledger});
  if(preview.candidateCount!==5||preview.uniqueRelevantMailCount!==10||preview.items.some(item=>!targets.some(target=>target.matterReference===item.matterReference)))throw new Error("NOTICE_PREVIEW_RESULT_REJECTED");
  const safe={...preview,schemaVersion:1,status:"live-notice-download-preview-validated",generatedAt:new Date().toISOString(),sourceMailSnapshotObservedAt:snapshot.observedAt,mcpToolCount:tools.tools.length,mcpCallCount,ledgerTablePresent:ledger.tablePresent,destinationZipCount:destinationFiles.length,noEasyPatFileDownloadPerformed:true,noZipCreated:true,noDestinationWritePerformed:true,noDatabaseWritePerformed:true};
  await writeFile(previewPath,JSON.stringify(safe,null,2),{mode:0o600});
  console.log(JSON.stringify(safe));
}catch(error){
  console.error(JSON.stringify({status:"live-notice-download-preview-failed",failureStage:stage,mcpCallCount,failureCode:/^[A-Z0-9_-]+$/.test(error?.message??"")?error.message:"NOTICE_PREVIEW_REJECTED",noEasyPatFileDownloadPerformed:true,noZipCreated:true,noDestinationWritePerformed:true,noDatabaseWritePerformed:true}));process.exitCode=1;
}finally{try{await client?.close();}catch{}}
