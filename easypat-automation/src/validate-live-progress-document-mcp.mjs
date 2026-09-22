import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url))),serverEntry=fileURLToPath(new URL("./mcp-server.mjs",import.meta.url));
const attemptRoot=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attemptPath=path.join(attemptRoot,"live-progress-document-mcp-attempt.v1.json");
const matterReference="PT261268",progressDocument="위임계약서 (x)",fileName="PT261268외1_수임내역서.pdf",sha256="002dc272a566509aa2e445ca8607e981b8eca73bbe919e4db40e1cceb8e0c657";
let client,claimed=false,startedAt,stage="preflight";
try{
  await mkdir(attemptRoot,{recursive:true});const info=await lstat(attemptRoot);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(attemptRoot)).toLowerCase()!==attemptRoot.toLowerCase())throw new Error("PREFLIGHT_REJECTED");
  startedAt=new Date().toISOString();await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"started",operation:"generic-mcp-progress-document",matterReference,progressDocument,startedAt}),{flag:"wx",mode:0o600});claimed=true;
  stage="mcp-connect";client=new Client({name:"easypat-progress-document-live-validator",version:"1.0.0"});await client.connect(new StdioClientTransport({command:process.execPath,args:[serverEntry],cwd:projectRoot,stderr:"pipe"}));
  const tools=await client.listTools(),names=new Set(tools.tools.map(tool=>tool.name));
  if(tools.tools.length!==8||!["easypat_list_progress_documents","easypat_download_progress_document","easypat_extract_progress_document_pdf"].every(name=>names.has(name)))throw new Error("MCP_REJECTED");
  const status=await client.callTool({name:"easypat_status",arguments:{}});
  if(status.isError||status.structuredContent?.genericProgressDocumentListingEnabled!==true||status.structuredContent?.genericProgressDocumentDownloadEnabled!==true||status.structuredContent?.genericProgressDocumentExtractionEnabled!==true||!status.structuredContent?.allowedOperations?.includes("download-document"))throw new Error("MCP_REJECTED");
  stage="mcp-list";const documents=await client.callTool({name:"easypat_list_progress_documents",arguments:{matterReference,progressDocument}});
  if(documents.isError||documents.structuredContent?.matterReference!==matterReference||documents.structuredContent?.progressDocument!==progressDocument||documents.structuredContent?.count!==1||documents.structuredContent?.items?.[0]?.fileName!==fileName||JSON.stringify(documents).includes("FILE_NAME_UPLOAD"))throw new Error("MCP_REJECTED");
  stage="mcp-extract";const extraction=await client.callTool({name:"easypat_extract_progress_document_pdf",arguments:{matterReference,fileName}});
  if(extraction.isError||extraction.structuredContent?.matterReference!==matterReference||extraction.structuredContent?.sourceSha256!==sha256||extraction.structuredContent?.pageCount!==2||extraction.structuredContent?.requestedMatterCount!==2||extraction.structuredContent?.requestedMatterPrefix!=="PT"||extraction.structuredContent?.rawTextReturned!==false||extraction.structuredContent?.emailAddressesReturned!==false||extraction.structuredContent?.contactDetailsReturned!==false)throw new Error("MCP_REJECTED");
  const completedAt=new Date().toISOString();await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"success",operation:"generic-mcp-progress-document",matterReference,progressDocument,startedAt,completedAt,toolCount:7,documentItemCount:1,pageCount:2,requestedMatterCount:2}),{mode:0o600});
  console.log(JSON.stringify({status:"live-progress-document-mcp-validated",matterReference,progressDocument,toolCount:7,documentItemCount:1,pdfExtractionVerified:true,requestedMatterCount:2,rawRowsReturned:false,rawTextReturned:false,emailAddressesReturned:false,contactDetailsReturned:false,serverUploadPathsReturned:false,internalIdentityReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false}));
}catch{
  if(claimed){try{await writeFile(attemptPath,JSON.stringify({schemaVersion:1,status:"failed",operation:"generic-mcp-progress-document",matterReference,progressDocument,startedAt,completedAt:new Date().toISOString(),failureStage:stage}),{mode:0o600});}catch{}}
  console.error(JSON.stringify({status:"live-progress-document-mcp-validation-failed",failureStage:stage,rawValuesReturned:false,rawTextReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false}));process.exitCode=1;
}finally{try{await client?.close();}catch{}}
