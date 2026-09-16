import { readFileSync } from "node:fs";
import { createFixedReadClient } from "./protocol/fixed-read-client.mjs";
import { createAuthenticationTransport } from "./protocol/authentication-transport.mjs";
import { createTemplateStore } from "./security/template-store.mjs";
import { createAuthenticationTemplateStore } from "./security/authentication-template-store.mjs";
import { createVerifiedAuthenticationAdapter } from "./security/authentication-adapter.mjs";
import { createSessionProvider } from "./security/session-provider.mjs";
import { projectMatterSummary } from "./protocol/matter-summary.mjs";
import { projectProgressList } from "./protocol/progress-list.mjs";
import { projectDocumentList } from "./protocol/document-list.mjs";
import { createDocumentDownloader } from "./protocol/document-downloader.mjs";
import { createGenericMatterSummaryClient } from "./protocol/generic-matter-summary-client.mjs";

// Called only by trusted local integration code. No user/LLM-supplied adapter.
export function createEasyPatRuntime({verifiedLoginAdapter}={}){
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8"));
  const policy=readJson("../config/safety-policy.json");
  const registry=readJson("../config/read-template-registry.json");
  const genericRegistry=readJson("../config/generic-read-template-registry.json");
  const mainSchema=readJson("../config/main-record-response-schema.json");
  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates;
  const authenticationTemplate=readJson("../config/authentication-template.json");
  const authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json");
  const store=createTemplateStore({candidates});
  const adapter=verifiedLoginAdapter===undefined?createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint}),expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()}):verifiedLoginAdapter;
  const session=createSessionProvider({adapter});
  const client=createFixedReadClient({policy,registry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  const downloader=createDocumentDownloader({policy,readDocuments:client.read,getSessionCookie:session.getSessionCookie});
  const genericSummary=createGenericMatterSummaryClient({policy,registry:genericRegistry,mainSchema,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  return Object.freeze({
    read:client.read,
    async readMatterSummary(input){return projectMatterSummary(await client.read(input));},
    async getMatterSummary(input){
      if(policy.genericMatterSummaryConstraints?.mcpExposureEnabled!==true)throw new Error("GENERIC_MCP_DISABLED");
      return genericSummary.lookupSummary(input);
    },
    async listProgress(input){return projectProgressList(await client.read(input));},
    async listDocuments(input){return projectDocumentList(await client.read(input),{contextBinding:"captured-p261793-fixed-document-group"});},
    downloadDocument:downloader.download,
    invalidateSession:session.invalidate,
    status(){return {session:session.status(),automaticAuthenticationReady:session.status().protocolVerified,sessionRefreshEnabled:false,enabledTemplateCount:registry.templates.filter(t=>t.enabled===true).length,genericMatterSummaryEnabled:genericSummary.status.enabled&&policy.genericMatterSummaryConstraints?.mcpExposureEnabled===true,genericMatterSummaryCandidateReady:genericSummary.status.enabled,genericMatterSummaryTemplateCount:genericSummary.status.templateCount,allowedOperations:[...policy.allowedOperations],credentialTarget:"EasyPAT/Automation",liveReady:session.status().protocolVerified&&registry.templates.some(t=>t.enabled===true&&t.boundMatterReference&&policy.allowedOperations.includes(t.operation))};},
  });
}
