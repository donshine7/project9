import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../src/validate-live-generic-matter.mjs", import.meta.url));

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

test("non-baseline live validator rejects the baseline before protected storage or network access", () => {
  const result = run(["--matter-reference", "P261793"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const output = JSON.parse(result.stderr);
  assert.equal(output.status, "live-generic-nonbaseline-failed");
  assert.equal(output.failureStage, "input");
  assert.equal(output.automaticRetryPerformed, false);
  assert.equal(output.serverMutationPerformed, false);
});

test("non-baseline live validator rejects unsafe caller input without echoing it", () => {
  const unsafe = "P261793' OR 1=1--";
  const result = run(["--matter-reference", unsafe]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /OR 1=1|261793/);
  const output = JSON.parse(result.stderr);
  assert.equal(output.status, "live-generic-nonbaseline-failed");
  assert.equal(output.failureStage, "input");
});

test("non-baseline live validator rejects an unapproved valid reference before protected storage or network access", () => {
  const result = run(["--matter-reference", "PT999999"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  const output = JSON.parse(result.stderr);
  assert.equal(output.status, "live-generic-nonbaseline-failed");
  assert.equal(output.failureStage, "preflight");
  assert.equal(output.automaticRetryPerformed, false);
  assert.equal(output.serverMutationPerformed, false);
});
