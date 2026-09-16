import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const serverEntry=fileURLToPath(new URL("./mcp-server.mjs",import.meta.url));
const attemptRoot=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const attemptPath=path.join(attemptRoot,"live-mcp-attempt.v1.json");
let client,claimed=false,startedAt;
try{
  await mkdir(attemptRoot,{recursive:true});const info=await lstat(attemptRoot);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(attemptRoot)).toLowerCase()!==attemptRoot.toLowerCase())throw new Error();
  startedAt=new Date().toISOString();await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"started",operation:"mcp-list-documents-and-read-extraction",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  client=new Client({name:"easypat-live-validator",version:"1.0.0"});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:projectRoot,stderr:"pipe"}));
  const tools=await client.listTools();if(tools.tools.length!==6)throw new Error();
  const status=await client.callTool({name:"easypat_status",arguments:{}});if(status.isError||status.structuredContent?.enabledTemplateCount!==3)throw new Error();
  const documents=await client.callTool({name:"easypat_list_documents",arguments:{matterReference:"P261793"}});if(documents.isError||documents.structuredContent?.count!==7)throw new Error();
  const extraction=await client.callTool({name:"easypat_get_document_extraction",arguments:{matterReference:"P261793",position:2}});if(extraction.isError||extraction.structuredContent?.amountExpressions?.length!==4||extraction.structuredContent?.keywordHits?.length!==5)throw new Error();
  const safe={status:"live-mcp-validated",toolCount:tools.tools.length,matterReference:"P261793",documentCount:documents.structuredContent.count,extractedAmountExpressionCount:extraction.structuredContent.amountExpressions.length,extractedKeywordCount:extraction.structuredContent.keywordHits.length,rawDocumentItemsReturned:false,rawOcrTextReturned:false,serverMutationPerformed:false,automaticRetryPerformed:false};
  await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"success",operation:"mcp-list-documents-and-read-extraction",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),toolCount:6,documentCount:7}),{mode:0o600});
  console.log(JSON.stringify(safe));
}catch{
  if(claimed){try{await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"failed",operation:"mcp-list-documents-and-read-extraction",matterReference:"P261793",startedAt,completedAt:new Date().toISOString()}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-mcp-validation-failed",rawValuesReturned:false,automaticRetryPerformed:false}));process.exitCode=1;
}finally{try{await client?.close();}catch{}}
