import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read=name=>JSON.parse(readFileSync(new URL(`../config/${name}`,import.meta.url),"utf8"));
const generic=read("generic-read-template-registry.json");
const production=read("read-template-registry.json");
const policy=read("safety-policy.json");
const mainSchema=read("main-record-response-schema.json");
const domesticUpload=read("domestic-report-upload-policy.json");

test("enables only the cross-matter validated generic summary path",()=>{
  assert.equal(generic.productionEnabled,true);
  assert.equal(generic.requiredDistinctNonBaselineMatterValidations,2);
  assert.equal(generic.completedDistinctNonBaselineMatterValidations,2);
  assert.deepEqual(generic.authorizedNonBaselineMatterReferences,["PT261129","PT261130"]);
  assert.deepEqual(generic.validatedNonBaselineMatterReferences,["PT261129","PT261130"]);
  assert.equal(generic.validatedNonBaselineMatterReferences.length,generic.completedDistinctNonBaselineMatterValidations);
  assert.equal(new Set(generic.authorizedNonBaselineMatterReferences).size,2);
  assert.ok(!generic.authorizedNonBaselineMatterReferences.includes(generic.baselineMatterReference));
  const summaryIds=new Set(["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.main-record.v1"]);
  assert.ok(generic.templates.filter(template=>summaryIds.has(template.templateId)).every(template=>template.productionEnabled===true));
  const progressCandidate=generic.templates.find(template=>template.templateId==="matter-detail.progress-records.v1");
  assert.equal(progressCandidate.productionEnabled,true);
  assert.equal(progressCandidate.completedDistinctNonBaselineMatterValidations,2);
  assert.deepEqual(progressCandidate.validatedNonBaselineMatterReferences,["PT261129","PT261130"]);
  const documentCandidate=generic.templates.find(template=>template.templateId==="matter-detail.documents.matter-candidate.v1");
  assert.equal(documentCandidate.productionEnabled,true);
  assert.equal(documentCandidate.parameterization.predicateColumn,"GRP_KEY");
  assert.equal(documentCandidate.completedDistinctNonBaselineMatterValidations,2);
  assert.deepEqual(documentCandidate.validatedNonBaselineMatterReferences,["PT261129","PT261130"]);
  assert.equal(generic.templates.find(template=>template.templateId==="matter-detail.documents.v1"),undefined);
  assert.equal(generic.status,"generic-summary-application-search-progress-document-list-download-and-extraction-ready");
  assert.equal(generic.summaryMcpLiveValidation.matterReference,"PT261130");
  assert.equal(generic.summaryMcpLiveValidation.safeProjectionFieldCount,7);
});

test("does not widen the current P261793 production policy",()=>{
  const enabled=production.templates.filter(template=>template.enabled===true);
  assert.ok(enabled.length>0);
  assert.ok(enabled.every(template=>template.boundMatterReference==="P261793"));
  for(const constraint of Object.values(policy.directReadConstraints)){
    assert.deepEqual(constraint.boundMatterReferences,["P261793"]);
  }
  assert.equal(policy.documentDownloadConstraints.matterReference,"P261793");
  assert.equal(policy.documentDownloadConstraints.enabled,false);
  assert.equal(policy.documentDownloadConstraints.matterBindingVerified,false);
  assert.equal(policy.genericMatterSummaryConstraints.enabled,true);
  assert.equal(policy.genericMatterSummaryConstraints.mcpExposureEnabled,true);
  assert.equal(policy.genericMatterSummaryConstraints.callerSuppliedSqlAllowed,false);
  assert.equal(policy.genericMatterSummaryConstraints.automaticRetryEnabled,false);
  assert.equal(policy.genericMatterSummaryConstraints.maximumSearchCandidateCount,500);
  assert.equal(policy.genericMatterSummaryConstraints.exactMatterReferenceMatchCountRequired,1);
  assert.deepEqual(policy.genericMatterSummaryConstraints.enabledTemplateIds,["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.main-record.v1"]);
  assert.equal(generic.applicationNumberSearch.productionEnabled,true);
  assert.equal(generic.applicationNumberSearch.liveValidationPending,false);
  assert.equal(generic.applicationNumberSearch.completedDistinctMatterValidations,2);
  assert.deepEqual(generic.applicationNumberSearch.validatedMatterReferences,["P261048","P261315"]);
  assert.equal(generic.applicationNumberSearch.mcpLiveValidation.toolCount,9);
  assert.equal(generic.applicationNumberSearch.mcpLiveValidation.safeProjectionFieldCount,5);
  assert.deepEqual(generic.applicationNumberSearch.sourceTemplateIds,["matter-search.exact-count.v1","matter-search.exact-result.v1"]);
  assert.equal(generic.applicationNumberSearch.sourcePredicateColumn,"ourref");
  assert.equal(generic.applicationNumberSearch.targetPredicateColumn,"n_app");
  assert.equal(policy.genericApplicationNumberSearchConstraints.enabled,true);
  assert.equal(policy.genericApplicationNumberSearchConstraints.mcpExposureEnabled,true);
  assert.equal(policy.genericApplicationNumberSearchConstraints.callerSuppliedSqlAllowed,false);
  assert.equal(generic.guarantees.genericApplicationNumberSearchProductionEnabled,true);
  assert.equal(policy.genericProgressConstraints.enabled,true);
  assert.equal(policy.genericProgressConstraints.mcpExposureEnabled,true);
  assert.deepEqual(policy.genericProgressConstraints.enabledTemplateIds,["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.progress-records.v1"]);
  assert.equal(policy.genericDocumentConstraints.enabled,true);
  assert.equal(policy.genericDocumentConstraints.mcpExposureEnabled,true);
  assert.equal(policy.genericDocumentConstraints.callerSuppliedGroupKeyAllowed,false);
  assert.deepEqual(policy.genericDocumentConstraints.enabledTemplateIds,["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.documents.matter-candidate.v1"]);
  assert.equal(policy.genericProgressDocumentConstraints.enabled,true);
  assert.equal(policy.genericProgressDocumentConstraints.mcpExposureEnabled,true);
  assert.equal(policy.genericProgressDocumentConstraints.requiredDistinctMatterValidations,2);
  assert.deepEqual(policy.genericProgressDocumentConstraints.validatedMatterReferences,["PT261268","P261793"]);
  assert.equal(policy.genericDownloadConstraints.enabled,true);
  assert.equal(policy.genericDownloadConstraints.mcpExposureEnabled,true);
  assert.equal(policy.genericDownloadConstraints.callerSuppliedUploadPathAllowed,false);
  assert.deepEqual(policy.genericDownloadConstraints.authorizedValidationMatterReferences,[
    "PT261268","P261793","P261048","P261315","P261487","P261489","P261610",
  ]);
  assert.equal(policy.genericDownloadConstraints.overwriteAllowed,false);
  assert.equal(policy.genericDownloadConstraints.sourceTemplateId,"matter-detail.progress-documents.v1");
});

test("stores no query text or internal identities and enables only fingerprinted templates",()=>{
  const text=JSON.stringify(generic);
  assert.doesNotMatch(text,/sqlText|queryText|statementText|cookie|password/i);
  assert.ok(generic.templates.every(template=>/^[a-f0-9]{64}$/.test(template.baseFingerprint)));
  assert.ok(generic.templates.filter(template=>template.productionEnabled).every(template=>/^[a-f0-9]{64}$/.test(template.baseFingerprint)));
  assert.equal(generic.guarantees.internalIdentityReturned,false);
  assert.equal(generic.guarantees.mutationEnabled,false);
});

test("pins the observed 205-column main-record schema without row values",()=>{
  assert.equal(mainSchema.templateId,"matter-detail.main-record.v1");
  assert.equal(mainSchema.columnCount,205);
  assert.equal(mainSchema.columns.length,205);
  assert.equal(new Set(mainSchema.columns.map(column=>column.toLowerCase())).size,205);
  assert.equal(mainSchema.rawRowValuesStored,false);
});

test("keeps domestic report upload in preview-only fail-closed mode until mutation evidence is complete",()=>{
  assert.equal(domesticUpload.status,"readback-and-cross-matter-validation-required");
  assert.equal(domesticUpload.previewEnabled,true);
  assert.equal(domesticUpload.commitEnabled,false);
  assert.equal(domesticUpload.mcpExposureEnabled,false);
  assert.equal(domesticUpload.defaults.timezone,"Asia/Seoul");
  assert.equal(domesticUpload.defaults.assignee,"장진태");
  assert.deepEqual(domesticUpload.allowedReportDocuments,["특허 출원 진행 요청","의견서 및 보정서 제출 요청"]);
  assert.equal(Object.values(domesticUpload.protocolEvidence).filter(Boolean).length,7);
  assert.equal(domesticUpload.protocolEvidence.readBackVerificationCaptured,false);
  assert.equal(domesticUpload.automaticRetryEnabled,false);
  assert.equal(domesticUpload.overwriteAllowed,false);
  assert.equal(domesticUpload.automaticRollbackEnabled,false);
});
