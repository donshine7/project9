import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const serverEntry=fileURLToPath(new URL("./mcp-server.mjs",import.meta.url));
const attemptRoot=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const attemptPath=path.join(attemptRoot,"live-notice-attachment-mcp-attempt.v1.json");
const expected=Object.freeze([
  {matterReference:"P261048",noticeDate:"2026-09-09",dueDate:"2027-01-09",aggregateAttachmentCount:37,count:8,searchCandidateCount:2},
  {matterReference:"P261315",noticeDate:"2026-09-10",dueDate:"2027-01-10",aggregateAttachmentCount:36,count:6,searchCandidateCount:2},
  {matterReference:"P261487",noticeDate:"2026-09-11",dueDate:"2027-01-11",aggregateAttachmentCount:42,count:6,searchCandidateCount:1},
  {matterReference:"P261489",noticeDate:"2026-09-09",dueDate:"2027-01-09",aggregateAttachmentCount:61,count:7,searchCandidateCount:1},
  {matterReference:"P261610",noticeDate:"2026-09-09",dueDate:"2027-01-09",aggregateAttachmentCount:31,count:6,searchCandidateCount:2},
]);

let client,stage="preflight",completed=0;
try{
  await mkdir(attemptRoot,{recursive:true});
  stage="mcp-connect";
  client=new Client({name:"easypat-notice-attachment-live-validator",version:"1.0.0"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:projectRoot,stderr:"pipe"}));
  const tools=await client.listTools(),toolNames=new Set(tools.tools.map(tool=>tool.name));
  if(tools.tools.length!==8||!toolNames.has("easypat_list_notice_attachments"))throw new Error("MCP_TOOL_INVENTORY_REJECTED");
  const status=await client.callTool({name:"easypat_status",arguments:{}});
  if(status.isError||status.structuredContent?.genericNoticeAttachmentListingEnabled!==true)throw new Error("MCP_STATUS_REJECTED");
  const matters=[];
  for(const item of expected){
    stage=`mcp-notice-attachments-${item.matterReference}`;
    const response=await client.callTool({name:"easypat_list_notice_attachments",arguments:{matterReference:item.matterReference,progressDocument:"의견제출통지서",noticeDate:item.noticeDate}});
    const value=response.structuredContent,serialized=JSON.stringify(response);
    if(response.isError||value?.matterReference!==item.matterReference||value?.noticeKind!=="opinion_submission"||value?.progressDocument!=="의견제출통지서"||value?.noticeDate!==item.noticeDate||value?.dueDate!==item.dueDate||
      value?.aggregateAttachmentCount!==item.aggregateAttachmentCount||value?.count!==item.count||!Array.isArray(value?.items)||value.items.length!==item.count||value.items.some((document,index)=>document?.position!==value.items[0].position+index)||
      /FILE_NAME_UPLOAD|upload\/|GRP_KEY|idx_parent|internalIdentity/i.test(serialized))throw new Error("MCP_NOTICE_RESULT_REJECTED");
    completed++;
    matters.push({matterReference:item.matterReference,noticeDate:value.noticeDate,dueDate:value.dueDate,aggregateAttachmentCount:value.aggregateAttachmentCount,packageAttachmentCount:value.count,searchCandidateCount:item.searchCandidateCount});
  }
  const result={schemaVersion:1,status:"live-notice-attachment-mcp-validated",validatedAt:new Date().toISOString(),toolCount:tools.tools.length,matterCount:matters.length,matters,rawRowsReturned:false,serverUploadPathsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false};
  await writeFile(attemptPath,JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify(result));
}catch(error){
  const failure={schemaVersion:1,status:"live-notice-attachment-mcp-validation-failed",failedAt:new Date().toISOString(),failureStage:stage,completedMatterCount:completed,failureCode:/^[A-Z0-9_-]+$/.test(error?.message??"")?error.message:"MCP_NOTICE_VALIDATION_REJECTED",rawValuesReturned:false,serverUploadPathsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false};
  try{await mkdir(attemptRoot,{recursive:true});await writeFile(attemptPath,JSON.stringify(failure,null,2),{mode:0o600});}catch{}
  console.error(JSON.stringify(failure));process.exitCode=1;
}finally{try{await client?.close();}catch{}}
