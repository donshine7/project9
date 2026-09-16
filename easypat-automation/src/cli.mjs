import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { assertDryRunOnly, buildPlan, classifyScreen, parseTasklistCsv } from "./core.mjs";

const execFileAsync = promisify(execFile);

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readStatus() {
  if (process.platform !== "win32") {
    return { appRunning: false, authState: "unknown", reason: "Windows is required" };
  }

  let processRow;
  let detectionSource = "tasklist";
  try {
    const { stdout } = await execFileAsync("tasklist.exe", [
      "/FI",
      "IMAGENAME eq boriview.3.44.exe",
      "/FO",
      "CSV",
      "/NH",
    ]);
    processRow = stdout
      .split(/\r?\n/)
      .map((line) => parseTasklistCsv(line.trim()))
      .find(Boolean);
  } catch {
    detectionSource = "Get-Process fallback";
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$p=Get-Process -Name 'boriview.3.44' -ErrorAction SilentlyContinue | Select-Object -First 1; if($p){$p.Id}",
    ]);
    const pid = Number(stdout.trim());
    if (Number.isInteger(pid) && pid > 0) {
      processRow = { imageName: "boriview.3.44.exe", pid };
    }
  }

  return {
    appRunning: Boolean(processRow),
    pid: processRow?.pid,
    detectionSource,
    authState: "unknown",
    nextAction: processRow
      ? "inspect the EasyPAT window; process presence alone does not prove login"
      : "start EasyPAT and let the user authenticate manually",
  };
}

async function main() {
  const command = process.argv[2];
  if (command === "policy") {
    const policyUrl = new URL("../config/safety-policy.json", import.meta.url);
    console.log(JSON.stringify(JSON.parse(await readFile(policyUrl, "utf8")), null, 2));
    return;
  }
  if (command === "status") {
    console.log(JSON.stringify(await readStatus(), null, 2));
    return;
  }

  if (command === "plan") {
    assertDryRunOnly(process.argv.includes("--execute"));
    const plan = buildPlan({
      operation: readOption("--operation") ?? "lookup",
      matterNumber: readOption("--matter"),
      reporter: readOption("--reporter"),
    });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (command === "classify") {
    const visibleText = readOption("--text");
    console.log(JSON.stringify(classifyScreen(visibleText), null, 2));
    return;
  }

  throw new Error(
    "usage: node src/cli.mjs policy | status | classify --text <visible text> | plan --operation lookup|add-progress --matter <OurRef> [--reporter <name>]",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
