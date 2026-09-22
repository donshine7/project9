import test from "node:test";
import assert from "node:assert/strict";
import {inspectRelatedCountsBinding} from "../src/protocol/related-counts-binding.mjs";
const envelope=(templateId,sql)=>({templateId,command:"SELECT",statements:[sql]});

test("finds a related-counts predicate bound to the matter identity without returning values",()=>{
  const result=inspectRelatedCountsBinding({mainEnvelope:envelope("matter-detail.main-record.v1","SELECT * FROM matters WHERE idx='private-matter'"),relatedEnvelope:envelope("matter-detail.related-counts.v1","SELECT * FROM counts WHERE idx_parent='private-matter' AND del_flag='N'")});
  assert.equal(result.matterBindingObserved,true);assert.deepEqual(result.matterIdentityPredicateColumns,["idx_parent"]);assert.doesNotMatch(JSON.stringify(result),/private/);
  assert.deepEqual(result.matterIdentityPredicateOccurrences,[{column:"idx_parent",occurrenceCount:1}]);
});

test("reports an unbound related-counts request and rejects mutations",()=>{
  const mainEnvelope=envelope("matter-detail.main-record.v1","SELECT * FROM matters WHERE idx='private-matter'");
  assert.equal(inspectRelatedCountsBinding({mainEnvelope,relatedEnvelope:envelope("matter-detail.related-counts.v1","SELECT * FROM counts WHERE idx_parent='other-private'")}).matterBindingObserved,false);
  assert.throws(()=>inspectRelatedCountsBinding({mainEnvelope,relatedEnvelope:{templateId:"matter-detail.related-counts.v1",command:"UPDATE",statements:["UPDATE counts SET x=1"]}}));
});
