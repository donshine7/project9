import { normalizeMatterNumber, validateProtocolIntent } from "../core.mjs";
import { verifyTemplateEnvelope } from "./template-fingerprint.mjs";
import { parseResultset } from "./resultset.mjs";
import { credentialColumns } from "./response-schema.mjs";
import { compilePredicateResponseIdentity, verifyPredicateResponseIdentity } from "./response-identity.mjs";
import { compileResponsePredicateSet, verifyResponsePredicateSet } from "./response-predicate-set.mjs";
import { createHttpsTransport, EASYPAT_ENDPOINT, EasyPatTransportError } from "./https-transport.mjs";

export class EasyPatReadError extends Error {
  constructor(code) { super(code); this.name = "EasyPatReadError"; this.code = code; }
}

// The providers are trusted local code, never LLM tool arguments. Fixed captures
// are restricted to their recorded matter; general key substitution is not implied.
export function createFixedReadClient({ policy, registry, loadTemplate, getSessionCookie, transport = createHttpsTransport() }) {
  const fixedPolicy = structuredClone(policy);
  const fixedRegistry = structuredClone(registry);
  return Object.freeze({
    async read(input) {
      if (!input || Object.keys(input).some(k => !["templateId", "matterReference"].includes(k))) throw new EasyPatReadError("INVALID_READ_INPUT");
      let matter;
      try { matter = normalizeMatterNumber(input.matterReference); }
      catch { throw new EasyPatReadError("INVALID_MATTER_REFERENCE"); }
      const registered = fixedRegistry?.templates?.find(t => t.templateId === input.templateId);
      if (!registered || registered.enabled !== true) throw new EasyPatReadError("TEMPLATE_NOT_ENABLED");
      if (registered.boundMatterReference !== matter) throw new EasyPatReadError("CAPTURE_MATTER_MISMATCH");
      try {
        validateProtocolIntent(fixedPolicy, {url:EASYPAT_ENDPOINT,operation:registered.operation,mutates:false});
        if (fixedPolicy.arbitrarySqlEnabled !== false || fixedPolicy.tlsVerificationRequired !== true) throw new Error();
        if (registered.responseVerification || registered.responsePredicateSetVerification) {
          const constraint=fixedPolicy.directReadConstraints?.[registered.operation];
          if (constraint?.uiNavigationReplayAllowed !== false || constraint?.exactResponseMatterMatchRequired !== true ||
              !constraint?.enabledTemplateIds?.includes(registered.templateId) ||
              !constraint?.boundMatterReferences?.includes(matter)) throw new Error();
        }
      } catch { throw new EasyPatReadError("POLICY_REJECTED"); }
      if (typeof loadTemplate !== "function") throw new EasyPatReadError("TEMPLATE_PROVIDER_REQUIRED");
      let body, responseIdentityBinding, responsePredicateSetBinding;
      try {
        const captured = await loadTemplate(registered.templateId);
        if (captured?.templateId !== registered.templateId || captured.command !== "SELECT" || captured.statements?.length !== 1) throw new Error();
        verifyTemplateEnvelope(fixedRegistry, captured);
        if (registered.responseVerification) {
          responseIdentityBinding = compilePredicateResponseIdentity(captured.statements[0], registered.responseVerification);
        }
        if(registered.responsePredicateSetVerification){
          responsePredicateSetBinding=compileResponsePredicateSet(captured.statements[0],registered.responsePredicateSetVerification);
        }
        const form = new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql:captured.statements[0]});
        body = form.toString();
      } catch { throw new EasyPatReadError("FIXED_TEMPLATE_REJECTED"); }
      if (typeof getSessionCookie !== "function") throw new EasyPatReadError("SESSION_PROVIDER_REQUIRED");
      let cookie;
      try { cookie = await getSessionCookie(); }
      catch { throw new EasyPatReadError("SESSION_PROVIDER_FAILED"); }
      if (typeof cookie !== "string" || !cookie.length || cookie.length > 8192 || /[^\x20-\x7e]/.test(cookie)) throw new EasyPatReadError("INVALID_SESSION_COOKIE");
      let response;
      try { response = await transport({ endpoint:EASYPAT_ENDPOINT,body,cookie }); }
      catch (error) {
        if (error instanceof EasyPatTransportError) throw error;
        throw new EasyPatReadError("TRANSPORT_FAILED");
      } finally { cookie = null; body = null; }
      let result;
      try {
        if (response?.status !== 200 || response.contentType !== "text/resultset") throw new Error();
        result = parseResultset(response.text);
      } catch { throw new EasyPatReadError("RESULTSET_REJECTED"); }
      finally { response = null; }
      // Known credential-style columns are never returned through a business read.
      // This is defense in depth, not a complete personal-data classifier.
      if (credentialColumns(result.columns).length) throw new EasyPatReadError("CREDENTIAL_COLUMNS_REJECTED");
      if (registered.expectedResponseColumns) {
        const expected=registered.expectedResponseColumns;
        if (!Array.isArray(expected) || !expected.length || expected.some(column=>typeof column!=="string") ||
            expected.length!==result.columns.length || expected.some((column,index)=>column!==result.columns[index])) {
          throw new EasyPatReadError("RESPONSE_SCHEMA_MISMATCH");
        }
      }
      if (registered.role === "search-results") {
        const key = result.columns.find(c => c.toLowerCase() === "ourref");
        if (!key || result.rows.length !== 1 || result.rows[0][key] !== matter) throw new EasyPatReadError("RESPONSE_MATTER_MISMATCH");
      }
      if (registered.responseVerification) {
        try { verifyPredicateResponseIdentity(result, responseIdentityBinding); }
        catch { throw new EasyPatReadError("RESPONSE_MATTER_MISMATCH"); }
        finally { responseIdentityBinding = null; }
      }
      if(registered.responsePredicateSetVerification){
        try{verifyResponsePredicateSet(result,responsePredicateSetBinding);}
        catch{throw new EasyPatReadError("RESPONSE_PREDICATE_SET_MISMATCH");}
        finally{responsePredicateSetBinding=null;}
      }
      return {matterReference:matter,templateId:registered.templateId,columns:result.columns,rows:result.rows};
    },
  });
}
