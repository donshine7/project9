import { readFileSync } from "node:fs";
import { createTemplateStore } from "./security/template-store.mjs";
import { compilePredicateResponseIdentity } from "./protocol/response-identity.mjs";

try {
  const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const registry = readJson("../config/read-template-registry.json");
  const fingerprints = readJson("../config/protocol-observations/local-read-fingerprints.json");
  const linkage = readJson("../config/protocol-observations/matter-linkage-evidence.json");
  const templateId = "matter-detail.main-record.v1";
  const configured = registry.templates.find(item => item.templateId === templateId);
  const candidate = fingerprints.candidates.find(item => item.templateId === templateId);
  const link = linkage.detailLinks.find(item => item.sessionId === candidate?.sessionId);
  if (!configured || configured.enabled !== true || configured.fingerprint !== candidate?.fingerprint ||
      configured.boundMatterReference !== "P261793" || candidate?.productionEnabled !== true || candidate?.sessionId !== 168 ||
      linkage.matterReference !== "P261793" || linkage.searchKeyField.toLowerCase() !== "idx" ||
      linkage.exactReferenceMatched !== true || linkage.actualLinkageVerified !== true ||
      !link?.matchingColumns?.some(item => item.column.toLowerCase() === "idx" && item.occurrences === 1)) {
    throw new Error();
  }
  const store = createTemplateStore({candidates:fingerprints.candidates});
  let envelope = await store.load(templateId);
  const binding = compilePredicateResponseIdentity(envelope.statements[0],configured.responseVerification);
  const safe = {
    status:"main-template-response-identity-production-ready",
    templateId,
    matterReference:"P261793",
    sourceSessionId:candidate.sessionId,
    searchIdentityField:linkage.searchKeyField,
    predicateColumn:configured.responseVerification.predicateColumn,
    responseColumn:binding.responseColumn,
    uniquePredicateIdentity:true,
    productionEnabled:true,
    serverRequestSent:false,
    rawStatementReturned:false,
    internalIdentityReturned:false,
  };
  envelope = null;
  console.log(JSON.stringify(safe));
} catch {
  console.error("MAIN_TEMPLATE_RESPONSE_IDENTITY_PREFLIGHT_FAILED");
  process.exitCode = 1;
}
