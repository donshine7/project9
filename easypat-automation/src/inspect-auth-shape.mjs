import { inspectAuthenticationSql, inspectCookieShape } from "./protocol/authentication-shape.mjs";
import { compileAuthenticationBinding } from "./protocol/authentication-binding.mjs";
import { inspectAuthenticationBatch } from "./protocol/authentication-batch.mjs";
import { compileAuthenticationBatch } from "./protocol/authentication-batch-binding.mjs";
import {createCredentialFreeAuthenticationTemplate} from "./security/authentication-template-store.mjs";
import {fingerprintEnvelope} from "./protocol/template-fingerprint.mjs";
const chunks = [];
let size = 0;
try {
  if (!["sql", "cookie", "binding", "batch", "batch-binding", "template"].includes(process.argv[2])) throw new Error();
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error();
    chunks.push(chunk);
  }
  const raw = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks));
  let result;
  if(process.argv[2] === "template"){
    const template=createCredentialFreeAuthenticationTemplate(raw);
    result={status:"credential-free-template-derived",templateId:template.templateId,fingerprint:fingerprintEnvelope(template),statementCount:template.statements.length,originalCredentialsIncluded:false,valuesIncluded:false,executable:false};
  } else if (process.argv[2] === "binding") {
    const compiled = compileAuthenticationBinding(raw);
    // Synthetic replacements only. Never sends a request or reads credentials.
    compiled.bind({username:"offline_binding_probe",password:"offline_probe_'_password"});
    result = {...compiled.summary, valuesIncluded:false, replacementRoundTripVerified:true};
  } else if (process.argv[2] === "batch-binding") {
    const compiled=compileAuthenticationBatch(raw);
    compiled.bind({username:"offline_binding_probe",password:"offline_probe_'_password"});
    result={...compiled.summary,replacementRoundTripVerified:true};
  } else if (process.argv[2] === "batch") result = inspectAuthenticationBatch(raw);
  else result = process.argv[2] === "sql" ? inspectAuthenticationSql(raw) : inspectCookieShape(raw);
  console.log(JSON.stringify(result));
} catch {
  console.error(JSON.stringify({status:"rejected",executable:false,reason:"authentication shape inspection failed"}));
  process.exitCode = 1;
} finally { chunks.forEach(c => c.fill(0)); }
