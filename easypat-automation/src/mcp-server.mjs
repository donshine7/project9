#!/usr/bin/env node
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {createEasyPatMcpServer} from "./mcp/server.mjs";

try{
  const server=createEasyPatMcpServer();
  await server.connect(new StdioServerTransport());
}catch{
  console.error("EASYPAT_MCP_START_FAILED");
  process.exitCode=1;
}
