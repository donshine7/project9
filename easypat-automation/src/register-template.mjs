import { readFile, rename, writeFile } from "node:fs/promises";
import { registerTemplateFingerprint } from "./protocol/template-registration.mjs";

const MAX_STDIN_BYTES = 1024 * 1024;

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readLimitedStdin() {
  if (process.stdin.isTTY) {
    throw new Error("pipe a trusted in-memory JSON envelope to stdin; interactive entry is disabled");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) throw new Error("registration input exceeds 1 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const templateId = option("--template-id");
  if (!templateId) throw new Error("--template-id is required");

  const registryUrl = new URL("../config/read-template-registry.json", import.meta.url);
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  const input = JSON.parse(await readLimitedStdin());
  const result = registerTemplateFingerprint(registry, templateId, input);

  if (result.summary.changed) {
    const temporaryUrl = new URL("../config/read-template-registry.json.tmp", import.meta.url);
    await writeFile(temporaryUrl, `${JSON.stringify(result.registry, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryUrl, registryUrl);
  }

  console.log(JSON.stringify(result.summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
