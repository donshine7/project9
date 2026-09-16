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
    assert.equal(tools.tools.length,6);
    const status=await client.callTool({name:"easypat_status",arguments:{}});
    assert.equal(status.isError,undefined);
    assert.equal(status.structuredContent.status,"ready");
    assert.equal(status.structuredContent.enabledTemplateCount,3);
    assert.equal(status.structuredContent.genericMatterSummaryEnabled,false);
    assert.equal(status.structuredContent.sessionRefreshEnabled,false);
  }finally{await client.close();}
});
