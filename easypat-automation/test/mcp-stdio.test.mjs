import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";

const root=fileURLToPath(new URL("../",import.meta.url));
const entry=fileURLToPath(new URL("../src/mcp-server.mjs",import.meta.url));

test("stdio entry point negotiates and exposes the scoped tool inventory",async()=>{
  const client=new Client({name:"stdio-smoke-test",version:"1.0.0"});
  const transport=new StdioClientTransport({command:process.execPath,args:[entry],cwd:root,stderr:"pipe"});
  try{
    await client.connect(transport);
    const tools=await client.listTools();
    assert.equal(tools.tools.length,9);
    assert.ok(tools.tools.some(tool=>tool.name==="easypat_search_by_application_number"));
    assert.ok(tools.tools.some(tool=>tool.name==="easypat_list_notice_attachments"));
    const status=await client.callTool({name:"easypat_status",arguments:{}});
    assert.equal(status.isError,undefined);
    assert.equal(status.structuredContent.status,"ready");
    assert.equal(status.structuredContent.enabledTemplateCount,3);
    assert.equal(status.structuredContent.genericMatterSummaryEnabled,true);
    assert.equal(status.structuredContent.genericApplicationNumberSearchEnabled,true);
    assert.equal(status.structuredContent.genericProgressListingEnabled,true);
    assert.equal(status.structuredContent.genericDocumentListingEnabled,true);
    assert.equal(status.structuredContent.genericProgressDocumentListingEnabled,true);
    assert.equal(status.structuredContent.genericNoticeAttachmentListingEnabled,true);
    assert.equal(status.structuredContent.genericProgressDocumentDownloadEnabled,true);
    assert.equal(status.structuredContent.genericProgressDocumentExtractionEnabled,true);
    assert.equal(status.structuredContent.domesticReportUploadPreviewImplemented,true);
    assert.equal(status.structuredContent.domesticReportUploadCommitEnabled,false);
    assert.equal(status.structuredContent.domesticReportUploadProtocolEvidenceComplete,false);
    assert.equal(status.structuredContent.documentMatterBindingVerified,false);
    assert.ok(status.structuredContent.allowedOperations.includes("list-documents"));
    assert.ok(status.structuredContent.allowedOperations.includes("download-document"));
    assert.equal(status.structuredContent.sessionRefreshEnabled,false);
  }finally{await client.close();}
});
