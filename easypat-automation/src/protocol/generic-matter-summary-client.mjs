import { validateProtocolIntent } from "../core.mjs";
import { createGeneralMatterLookup } from "./general-matter-lookup.mjs";
import { createHttpsTransport, EASYPAT_ENDPOINT } from "./https-transport.mjs";
import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { parseResultset } from "./resultset.mjs";

const TEMPLATE_IDS = Object.freeze([
  "matter-search.exact-count.v1",
  "matter-search.exact-result.v1",
  "matter-detail.main-record.v1",
]);

function sameMembers(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    new Set(left).size === left.length && left.every((value) => right.includes(value));
}

// Production adapter for the already live-validated generic chain. The public
// input remains only a full matter reference; statements, URL, cookie, retry,
// mutation and internal identity never cross this boundary.
export function createGenericMatterSummaryClient({
  policy,
  registry,
  mainSchema,
  loadTemplate,
  getSessionCookie,
  transport = createHttpsTransport(),
}) {
  const fixedPolicy = structuredClone(policy);
  const fixedRegistry = structuredClone(registry);
  const fixedSchema = structuredClone(mainSchema);
  const constraint = fixedPolicy?.genericMatterSummaryConstraints;
  if (
    fixedRegistry?.productionEnabled !== true ||
    fixedRegistry?.completedDistinctNonBaselineMatterValidations !== fixedRegistry?.requiredDistinctNonBaselineMatterValidations ||
    fixedRegistry?.requiredDistinctNonBaselineMatterValidations < 2 ||
    !sameMembers(fixedRegistry?.authorizedNonBaselineMatterReferences, fixedRegistry?.validatedNonBaselineMatterReferences) ||
    constraint?.enabled !== true ||
    !sameMembers(constraint?.enabledTemplateIds, TEMPLATE_IDS) ||
    constraint?.maximumSearchCandidateCount !== 500 ||
    constraint?.exactMatterReferenceMatchCountRequired !== 1 ||
    constraint?.exactMatterReferenceMatchRequired !== true ||
    constraint?.verifiedInternalIdentityRequired !== true ||
    constraint?.callerSuppliedSqlAllowed !== false ||
    constraint?.automaticRetryEnabled !== false ||
    fixedPolicy?.mutationOperationsEnabled !== false ||
    fixedPolicy?.arbitrarySqlEnabled !== false ||
    fixedPolicy?.tlsVerificationRequired !== true ||
    typeof loadTemplate !== "function" ||
    typeof getSessionCookie !== "function" ||
    typeof transport !== "function"
  ) throw new Error("GENERIC_SUMMARY_CONFIGURATION_REJECTED");

  const definition = (id) => structuredClone(fixedRegistry.templates.find((template) => template.templateId === id));
  const countDefinition = definition(TEMPLATE_IDS[0]);
  const searchDefinition = definition(TEMPLATE_IDS[1]);
  const detailDefinition = definition(TEMPLATE_IDS[2]);
  if (
    [countDefinition, searchDefinition, detailDefinition].some((item) => !item || item.productionEnabled !== true) ||
    fixedSchema?.templateId !== detailDefinition.templateId || fixedSchema?.columnCount !== 205 ||
    fixedSchema?.columns?.length !== 205 || fixedSchema?.rawRowValuesStored !== false
  ) throw new Error("GENERIC_SUMMARY_CONFIGURATION_REJECTED");
  detailDefinition.expectedResponseColumns = [...fixedSchema.columns];
  delete detailDefinition.expectedResponseColumnsSource;

  const roles = new Map([
    ["count-results", { operation: "search-matter", templateId: countDefinition.templateId }],
    ["fetch-result-rows", { operation: "search-matter", templateId: searchDefinition.templateId }],
    ["main-matter-record", { operation: "get-matter-detail", templateId: detailDefinition.templateId }],
  ]);
  const executeRead = async ({ operation, role, envelope }) => {
    const expected = roles.get(role);
    if (!expected || expected.operation !== operation || envelope?.templateId !== expected.templateId) {
      throw new Error("GENERIC_SUMMARY_READ_REJECTED");
    }
    validateProtocolIntent(fixedPolicy, { url: EASYPAT_ENDPOINT, operation, mutates: false });
    createReadOnlyBatch([envelope]);
    let cookie;
    let body;
    let response;
    try {
      cookie = await getSessionCookie();
      body = new URLSearchParams({
        connection: "EASYPAT_S_SSPAT",
        count: "1",
        command: "SELECT",
        sql: envelope.statements[0],
      }).toString();
      response = await transport({ endpoint: EASYPAT_ENDPOINT, body, cookie });
      if (response?.status !== 200 || response.contentType !== "text/resultset") throw new Error("GENERIC_SUMMARY_READ_REJECTED");
      const parsed = parseResultset(response.text);
      return { templateId: envelope.templateId, columns: parsed.columns, rows: parsed.rows };
    } finally {
      cookie = null;
      body = null;
      response = null;
    }
  };

  const lookup = createGeneralMatterLookup({
    countDefinition,
    searchDefinition,
    detailDefinition,
    loadTemplate,
    executeRead,
  });
  return Object.freeze({
    lookupSummary: lookup.lookupSummary,
    status: Object.freeze({ enabled: true, templateCount: TEMPLATE_IDS.length, automaticRetryEnabled: false }),
  });
}
