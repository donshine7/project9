import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read=name=>JSON.parse(readFileSync(new URL(`../config/${name}`,import.meta.url),"utf8"));
const generic=read("generic-read-template-registry.json");
const production=read("read-template-registry.json");
const policy=read("safety-policy.json");
const mainSchema=read("main-record-response-schema.json");

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
  assert.equal(generic.templates.find(template=>template.templateId==="matter-detail.progress-records.v1").productionEnabled,false);
  assert.equal(generic.templates.find(template=>template.templateId==="matter-detail.documents.v1"),undefined);
  assert.equal(generic.status,"generic-summary-validated-progress-candidate-document-source-discovery-required");
});

test("does not widen the current P261793 production policy",()=>{
  const enabled=production.templates.filter(template=>template.enabled===true);
  assert.ok(enabled.length>0);
  assert.ok(enabled.every(template=>template.boundMatterReference==="P261793"));
  for(const constraint of Object.values(policy.directReadConstraints)){
    assert.deepEqual(constraint.boundMatterReferences,["P261793"]);
  }
  assert.equal(policy.documentDownloadConstraints.matterReference,"P261793");
  assert.equal(policy.genericMatterSummaryConstraints.enabled,true);
  assert.equal(policy.genericMatterSummaryConstraints.mcpExposureEnabled,false);
  assert.equal(policy.genericMatterSummaryConstraints.callerSuppliedSqlAllowed,false);
  assert.equal(policy.genericMatterSummaryConstraints.automaticRetryEnabled,false);
  assert.deepEqual(policy.genericMatterSummaryConstraints.enabledTemplateIds,["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.main-record.v1"]);
  assert.equal(policy.genericProgressConstraints.enabled,false);
  assert.equal(policy.genericProgressConstraints.mcpExposureEnabled,false);
  assert.deepEqual(policy.genericProgressConstraints.enabledTemplateIds,["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.progress-records.v1"]);
  assert.equal(policy.genericDocumentConstraints.enabled,false);
  assert.equal(policy.genericDocumentConstraints.mcpExposureEnabled,false);
  assert.equal(policy.genericDocumentConstraints.callerSuppliedGroupKeyAllowed,false);
  assert.deepEqual(policy.genericDocumentConstraints.enabledTemplateIds,["matter-search.exact-count.v1","matter-search.exact-result.v1","matter-detail.documents.v1"]);
  assert.equal(policy.genericDownloadConstraints.enabled,false);
  assert.equal(policy.genericDownloadConstraints.mcpExposureEnabled,false);
  assert.equal(policy.genericDownloadConstraints.callerSuppliedUploadPathAllowed,false);
  assert.equal(policy.genericDownloadConstraints.overwriteAllowed,false);
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
