import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const projectRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const serverEntry = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));
const attemptRoot = path.resolve(fileURLToPath(new URL("../.local/templates-user/", import.meta.url)));
const attemptPath = path.join(attemptRoot, "live-generic-mcp-attempt.v2.json");
const matterReference = "PT261130";
let client;
let claimed = false;
let startedAt;
let stage = "preflight";

try {
  await mkdir(attemptRoot, { recursive: true });
  const info = await lstat(attemptRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || path.resolve(await realpath(attemptRoot)).toLowerCase() !== attemptRoot.toLowerCase()) {
    throw new Error("PREFLIGHT_REJECTED");
  }
  startedAt = new Date().toISOString();
  await writeFile(attemptPath, JSON.stringify({
    schemaVersion: 1,
    status: "started",
    operation: "generic-mcp-matter-summary",
    matterReference,
    startedAt,
  }), { flag: "wx", mode: 0o600 });
  claimed = true;

  stage = "mcp-connect";
  client = new Client({ name: "easypat-generic-live-validator", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverEntry], cwd: projectRoot, stderr: "pipe" }));
  const tools = await client.listTools();
  if (tools.tools.length !== 9 || !tools.tools.some((tool) => tool.name === "easypat_get_matter_summary")) throw new Error("MCP_REJECTED");
  const status = await client.callTool({ name: "easypat_status", arguments: {} });
  if (status.isError || status.structuredContent?.genericMatterSummaryEnabled !== true) throw new Error("MCP_REJECTED");

  stage = "mcp-generic-summary";
  const summary = await client.callTool({ name: "easypat_get_matter_summary", arguments: { matterReference } });
  if (summary.isError || summary.structuredContent?.matterReference !== matterReference || Object.keys(summary.structuredContent).length !== 8) {
    throw new Error("MCP_REJECTED");
  }
  const completedAt = new Date().toISOString();
  await writeFile(attemptPath, JSON.stringify({
    schemaVersion: 1,
    status: "success",
    operation: "generic-mcp-matter-summary",
    matterReference,
    startedAt,
    completedAt,
    toolCount: 9,
    safeProjectionFieldCount: 7,
  }), { mode: 0o600 });
  console.log(JSON.stringify({
    status: "live-generic-mcp-validated",
    matterReference,
    toolCount: 9,
    safeProjectionFieldCount: 7,
    rawRowsReturned: false,
    internalIdentityReturned: false,
    automaticRetryPerformed: false,
    serverMutationPerformed: false,
  }));
} catch {
  if (claimed) {
    try {
      await writeFile(attemptPath, JSON.stringify({
        schemaVersion: 1,
        status: "failed",
        operation: "generic-mcp-matter-summary",
        matterReference,
        startedAt,
        completedAt: new Date().toISOString(),
        failureStage: stage,
      }), { mode: 0o600 });
    } catch {}
  }
  console.error(JSON.stringify({
    status: "live-generic-mcp-validation-failed",
    failureStage: stage,
    rawValuesReturned: false,
    automaticRetryPerformed: false,
    serverMutationPerformed: false,
  }));
  process.exitCode = 1;
} finally {
  try { await client?.close(); } catch {}
}
