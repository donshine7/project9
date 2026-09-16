import { inspectFiddlerCapture } from "./protocol/fiddler-capture.mjs";

// Receive one already-authorized MCP session through stdin, never a raw CLI arg.
// No network calls, file writes, or activation of templates.
const chunks = [];
let size = 0;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("capture input too large");
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("capture input must be JSON"); }
  console.log(JSON.stringify(inspectFiddlerCapture(input)));
} catch {
  // Parse errors can contain source fragments; never echo the original error.
  console.error(JSON.stringify({ status: "rejected", executable: false, reason: "invalid, redacted, or unsupported capture" }));
  process.exitCode = 1;
} finally {
  chunks.forEach(chunk => chunk.fill(0));
}
