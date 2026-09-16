import assert from "node:assert/strict";
import test from "node:test";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import {createEasyPatMcpServer} from "../src/mcp/server.mjs";

async function connected(fakeRuntime,readExtraction=async()=>({matterContext:"P261793",sourceFileName:"P261545외_수임내역서(수정).jpg",ocrEngine:"windows-media-ocr",ocrLanguage:"ko-KR",lineCount:12,matterReferences:[],amountExpressions:["600+60"],keywordHits:["특허"],maskedTokenCount:1,rawOcrTextReturned:false,externalUploadPerformed:false})){
  const server=createEasyPatMcpServer({runtime:fakeRuntime,readExtraction});
  const client=new Client({name:"test-client",version:"1.0.0"});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  return{client,server};
}

function runtime(){return{status:()=>({automaticAuthenticationReady:true,enabledTemplateCount:3,genericMatterSummaryEnabled:true,allowedOperations:["get-matter-detail","list-progress","list-documents","download-document"]}),getMatterSummary:async({matterReference})=>({matterReference,rightType:null,applicationKind:null,applicationDivision:null,applicationDate:null,applicationNumber:null,titleKorean:null,status:null}),listProgress:async()=>({matterReference:"P261793",count:0,items:[]}),listDocuments:async()=>({matterReference:"P261793",count:0,items:[]}),downloadDocument:async()=>({matterReference:"P261793",position:2,fileName:"P261545외_수임내역서(수정).jpg",fileSizeBytes:51373,contentType:"image/jpeg",sha256:"a".repeat(64),path:"C:\\safe\\file.jpg",downloaded:false,alreadyPresent:true,overwritten:false,automaticRetryPerformed:false,serverMutationPerformed:false,serverUploadPathReturned:false})};}

test("lists six scoped EasyPAT tools with a generic summary input only",async()=>{const {client,server}=await connected(runtime());try{const listed=await client.listTools();assert.deepEqual(listed.tools.map(tool=>tool.name),["easypat_status","easypat_get_matter_summary","easypat_list_progress","easypat_list_documents","easypat_download_document","easypat_get_document_extraction"]);const summary=listed.tools.find(tool=>tool.name==="easypat_get_matter_summary");assert.match(JSON.stringify(summary.inputSchema),/PPT\|PT\|P\|T/);assert.ok(listed.tools.every(tool=>!JSON.stringify(tool.inputSchema).match(/sql|cookie|url/i)));}finally{await client.close();await server.close();}});

test("accepts a full generic matter identity but keeps unsafe input and downloads fixed",async()=>{const {client,server}=await connected(runtime());try{const summary=await client.callTool({name:"easypat_get_matter_summary",arguments:{matterReference:"PT261130"}});assert.equal(summary.isError,undefined);assert.equal(summary.structuredContent.matterReference,"PT261130");for(const [name,args] of [["easypat_get_matter_summary",{matterReference:"PT261130' OR 1=1--"}],["easypat_download_document",{matterReference:"P261793",position:1,expectedFileName:"P261545외_수임내역서(수정).jpg"}]]){const result=await client.callTool({name,arguments:args});assert.equal(result.isError,true);}}finally{await client.close();await server.close();}});

test("returns structured safe data and sanitizes runtime failures",async()=>{const fake=runtime();const {client,server}=await connected(fake);try{const extraction=await client.callTool({name:"easypat_get_document_extraction",arguments:{matterReference:"P261793",position:2}});assert.equal(extraction.structuredContent.rawOcrTextReturned,false);assert.deepEqual(extraction.structuredContent.amountExpressions,["600+60"]);fake.listDocuments=async()=>{throw new Error("secret SQL and cookie");};const failed=await client.callTool({name:"easypat_list_documents",arguments:{matterReference:"P261793"}});assert.equal(failed.isError,true);assert.doesNotMatch(JSON.stringify(failed),/secret|SQL|cookie/);}finally{await client.close();await server.close();}});
