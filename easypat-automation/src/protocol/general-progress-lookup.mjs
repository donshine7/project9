import { credentialColumns } from "./response-schema.mjs";
import { compilePredicateResponseIdentity, verifyPredicateResponseIdentity } from "./response-identity.mjs";
import { projectProgressList } from "./progress-list.mjs";
import { normalizeExactMatterReference } from "./matter-reference.mjs";
import {
  bindMatterIdentityDetailTemplate,
  bindMatterReferenceSearchTemplate,
  createMatterIdentityContext,
} from "./parameterized-read-template.mjs";

export class GeneralProgressLookupError extends Error {
  constructor(code) { super(code); this.name = "GeneralProgressLookupError"; this.code = code; }
}

function exactSchema(result, expected) {
  return Array.isArray(expected) && expected.length > 0 && Array.isArray(result?.columns) &&
    expected.length === result.columns.length && expected.every((column, index) => column === result.columns[index]);
}

// Candidate general progress chain. It repeats the exact matter search so the
// progress predicate is always derived from a fresh, server-returned identity.
// The caller can supply only the full matter reference.
export function createGeneralProgressLookup({ countDefinition, searchDefinition, progressDefinition, loadTemplate, executeRead }) {
  const count = structuredClone(countDefinition);
  const search = structuredClone(searchDefinition);
  const progress = structuredClone(progressDefinition);
  if (typeof loadTemplate !== "function" || typeof executeRead !== "function") throw new Error("GENERAL_PROGRESS_PROVIDER_REJECTED");
  return Object.freeze({
    async list(input) {
      if (!input || Object.keys(input).sort().join(",") !== "matterReference") throw new GeneralProgressLookupError("GENERAL_PROGRESS_INPUT_REJECTED");
      let matter;
      let countEnvelope;
      let countResult;
      let searchEnvelope;
      let searchResult;
      let context;
      let progressEnvelope;
      let progressResult;
      let binding;
      try { matter = normalizeExactMatterReference(input.matterReference); }
      catch { throw new GeneralProgressLookupError("GENERAL_PROGRESS_INPUT_REJECTED"); }
      try {
        countEnvelope = bindMatterReferenceSearchTemplate({ envelope: await loadTemplate(count.templateId), definition: count, matterReference: matter });
        countResult = await executeRead({ operation: "search-matter", role: "count-results", envelope: countEnvelope });
        if (!countResult || countResult.templateId !== count.templateId || !exactSchema(countResult, count.expectedResponseColumns) ||
            !Array.isArray(countResult.rows) || countResult.rows.length !== 1 || countResult.rows[0]?.[count.responseCountColumn] !== "1" ||
            credentialColumns(countResult.columns).length) throw new Error();
        searchEnvelope = bindMatterReferenceSearchTemplate({ envelope: await loadTemplate(search.templateId), definition: search, matterReference: matter });
        searchResult = await executeRead({ operation: "search-matter", role: "fetch-result-rows", envelope: searchEnvelope });
        context = createMatterIdentityContext({ matterReference: matter, searchResult, definition: search });
      } catch { throw new GeneralProgressLookupError("GENERAL_PROGRESS_SEARCH_REJECTED"); }
      finally { countEnvelope = null; countResult = null; searchEnvelope = null; searchResult = null; }
      try {
        progressEnvelope = bindMatterIdentityDetailTemplate({ envelope: await loadTemplate(progress.templateId), definition: progress, context });
        binding = compilePredicateResponseIdentity(progressEnvelope.statements[0], progress.responseVerification);
        progressResult = await executeRead({ operation: "list-progress", role: "progress-records", envelope: progressEnvelope });
        if (!progressResult || progressResult.templateId !== progress.templateId || !exactSchema(progressResult, progress.expectedResponseColumns) ||
            !Array.isArray(progressResult.rows) || credentialColumns(progressResult.columns).length) throw new Error();
        verifyPredicateResponseIdentity(progressResult, binding);
        return projectProgressList({ ...progressResult, matterReference: matter });
      } catch { throw new GeneralProgressLookupError("GENERAL_PROGRESS_RESULT_REJECTED"); }
      finally { context = null; progressEnvelope = null; progressResult = null; binding = null; }
    },
  });
}
