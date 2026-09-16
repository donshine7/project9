import { credentialColumns } from "./response-schema.mjs";
import { compilePredicateResponseIdentity, verifyPredicateResponseIdentity } from "./response-identity.mjs";
import { projectMatterSummary } from "./matter-summary.mjs";
import { normalizeExactMatterReference } from "./matter-reference.mjs";
import {
  bindMatterIdentityDetailTemplate,
  bindMatterReferenceSearchTemplate,
  createMatterIdentityContext,
} from "./parameterized-read-template.mjs";

export class GeneralMatterLookupError extends Error {
  constructor(code) { super(code); this.name="GeneralMatterLookupError"; this.code=code; }
}

function exactSchema(result, expected) {
  return Array.isArray(expected) && expected.length>0 && Array.isArray(result?.columns) &&
    expected.length===result.columns.length && expected.every((column,index)=>column===result.columns[index]);
}

// Offline-ready orchestration for the future generic path. loadTemplate and
// executeRead are trusted local providers. No caller-supplied SQL, URL, cookie,
// internal key, retry option, or mutation option is accepted.
export function createGeneralMatterLookup({countDefinition, searchDefinition, detailDefinition, loadTemplate, executeRead}) {
  const count=structuredClone(countDefinition),search=structuredClone(searchDefinition), detail=structuredClone(detailDefinition);
  if (typeof loadTemplate!=="function" || typeof executeRead!=="function") throw new Error("GENERAL_LOOKUP_PROVIDER_REJECTED");
  return Object.freeze({
    async lookupSummary(input) {
      if (!input || Object.keys(input).sort().join(",")!=="matterReference") throw new GeneralMatterLookupError("GENERAL_LOOKUP_INPUT_REJECTED");
      let matter,countEnvelope,countResult,searchEnvelope,searchResult,context,detailEnvelope,detailResult,binding;
      try { matter=normalizeExactMatterReference(input.matterReference); }
      catch { throw new GeneralMatterLookupError("GENERAL_LOOKUP_INPUT_REJECTED"); }
      try {
        countEnvelope=bindMatterReferenceSearchTemplate({envelope:await loadTemplate(count.templateId),definition:count,matterReference:matter});
        countResult=await executeRead({operation:"search-matter",role:"count-results",envelope:countEnvelope});
        if(!countResult||countResult.templateId!==count.templateId||!exactSchema(countResult,count.expectedResponseColumns)||
           !Array.isArray(countResult.rows)||countResult.rows.length!==1||countResult.rows[0]?.[count.responseCountColumn]!=="1"||
           credentialColumns(countResult.columns).length)throw new Error();
        searchEnvelope=bindMatterReferenceSearchTemplate({envelope:await loadTemplate(search.templateId),definition:search,matterReference:matter});
        searchResult=await executeRead({operation:"search-matter",role:"fetch-result-rows",envelope:searchEnvelope});
        context=createMatterIdentityContext({matterReference:matter,searchResult,definition:search});
      } catch { throw new GeneralMatterLookupError("GENERAL_LOOKUP_SEARCH_REJECTED"); }
      finally { countEnvelope=null; countResult=null; searchEnvelope=null; searchResult=null; }
      try {
        detailEnvelope=bindMatterIdentityDetailTemplate({envelope:await loadTemplate(detail.templateId),definition:detail,context});
        binding=compilePredicateResponseIdentity(detailEnvelope.statements[0],detail.responseVerification);
        detailResult=await executeRead({operation:"get-matter-detail",role:"main-matter-record",envelope:detailEnvelope});
        if (!detailResult || detailResult.templateId!==detail.templateId || !exactSchema(detailResult,detail.expectedResponseColumns) ||
            !Array.isArray(detailResult.rows) || credentialColumns(detailResult.columns).length) throw new Error();
        verifyPredicateResponseIdentity(detailResult,binding);
        return projectMatterSummary({...detailResult,matterReference:matter});
      } catch { throw new GeneralMatterLookupError("GENERAL_LOOKUP_DETAIL_REJECTED"); }
      finally { context=null; detailEnvelope=null; detailResult=null; binding=null; }
    },
  });
}
