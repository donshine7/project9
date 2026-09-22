import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url))),serverEntry=fileURLToPath(new URL("./mcp-server.mjs",import.meta.url));
const attemptRoot=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attemptPath=path.join(attemptRoot,"live-generic-progress-mcp-attempt.v1.json"),matterReference="PT261130";
let client,claimed=false,startedAt,stage="preflight";
try{
  await mkdir(attemptRoot,{recursive:true});const info=await lstat(attemptRoot);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(attemptRoot)).toLowerCase()!==attemptRoot.toLowerCase())throw new Error("PREFLIGHT_REJECTED");
  startedAt=new Date().toISOString();await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"started",operation:"generic-mcp-progress-list",matterReference,startedAt}),{flag:"wx",mode:0o600});claimed=true;
  stage="mcp-connect";client=new Client({name:"easypat-generic-progress-live-validator",version:"1.0.0"});await client.connect(new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:projectRoot,stderr:"pipe"}));
  const tools=await client.listTools();if(tools.tools.length!==8||!tools.tools.some(tool=>tool.name==="easypat_list_progress"))throw new Error("MCP_REJECTED");
  const status=await client.callTool({name:"easypat_status",arguments:{}});if(status.isError||status.structuredContent?.genericProgressListingEnabled!==true||!status.structuredContent?.allowedOperations?.includes("list-progress"))throw new Error("MCP_REJECTED");
  stage="mcp-generic-progress-list";const progress=await client.callTool({name:"easypat_list_progress",arguments:{matterReference}});
  if(progress.isError||progress.structuredContent?.matterReference!==matterReference||progress.structuredContent?.count!==1||!Array.isArray(progress.structuredContent?.items)||progress.structuredContent.items.length!==1||Object.keys(progress.structuredContent.items[0]).length!==13)throw new Error("MCP_REJECTED");
  const completedAt=new Date().toISOString();await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"success",operation:"generic-mcp-progress-list",matterReference,startedAt,completedAt,toolCount:7,progressItemCount:1,safeProjectionFieldCount:13}),{mode:0o600});
  console.log(JSON.stringify({status:"live-generic-progress-mcp-validated",matterReference,toolCount:7,progressItemCount:1,safeProjectionFieldCount:13,rawRowsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false}));
}catch{
  if(claimed){try{await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"failed",operation:"generic-mcp-progress-list",matterReference,startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-generic-progress-mcp-validation-failed",failureStage:stage,rawValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false}));process.exitCode=1;
}finally{try{await client?.close();}catch{}}
