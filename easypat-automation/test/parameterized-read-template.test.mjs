import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintEnvelope } from "../src/protocol/template-fingerprint.mjs";
import { collectLiteralEqualities } from "../src/protocol/matter-linkage.mjs";
import {
  bindMatterIdentityDetailTemplate,
  bindMatterReferenceSearchTemplate,
  bindTrustedDerivedScalarTemplate,
  createMatterIdentityContext,
  readMatterSearchCandidateCount,
} from "../src/protocol/parameterized-read-template.mjs";

const searchEnvelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:["SELECT idx, ourref FROM matters WHERE ourref = 'P261793'"]};
const detailEnvelope={templateId:"matter-detail.main-record.v1",command:"SELECT",statements:["SELECT idx, app_right FROM matters WHERE idx = 'baseline-private-key'"]};
const searchDefinition={
  templateId:searchEnvelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(searchEnvelope),productionEnabled:false,
  parameterization:{mode:"single-literal-equality",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793"},
  responseMatterColumn:"ourref",responseIdentityColumn:"idx",expectedResponseColumns:["idx","ourref"],
};
const detailDefinition={
  templateId:detailEnvelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(detailEnvelope),productionEnabled:false,
  parameterization:{mode:"single-literal-equality",source:"verified-search-identity",predicateColumn:"idx",sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"},
};

function context(identity="another-private-key",matter="P261830-S1"){
  return createMatterIdentityContext({matterReference:matter,definition:searchDefinition,searchResult:{
    templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:[{idx:identity,ourref:matter}],
  }});
}

test("binds only the exact matter-reference literal in a fingerprinted search template",()=>{
  const compiled=bindMatterReferenceSearchTemplate({envelope:searchEnvelope,definition:searchDefinition,matterReference:"p261830-s1"});
  assert.equal(compiled.statements[0],"SELECT idx, ourref FROM matters WHERE ourref = 'P261830-S1'");
  assert.equal(compiled.templateId,searchEnvelope.templateId);
});

test("binds all four observed LIKE contains slots together without changing query structure",()=>{
  const statement=["SELECT idx, ourref FROM a WHERE ourref LIKE '%P261793%'","UNION ALL SELECT idx, ourref FROM b WHERE ourref LIKE '%P261793%'","UNION ALL SELECT idx, ourref FROM c WHERE ourref LIKE '%P261793%'","UNION ALL SELECT idx, ourref FROM d WHERE ourref LIKE '%P261793%'"].join(" ");
  const envelope={templateId:"matter-search.exact-result.v1",command:"SELECT",statements:[statement]};
  const definition={...searchDefinition,baseFingerprint:fingerprintEnvelope(envelope),parameterization:{mode:"repeated-like-contains",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793",expectedOccurrenceCount:4}};
  const compiled=bindMatterReferenceSearchTemplate({envelope,definition,matterReference:"P261830-CN(PA)"});
  assert.equal(compiled.statements[0].match(/%P261830-CN\(PA\)%/g)?.length,4);
  const changed={...envelope,statements:[statement.replace("LIKE '%P261793%'","LIKE '%P261793-S1%'")]};
  const changedDefinition={...definition,baseFingerprint:fingerprintEnvelope(changed)};
  assert.throws(()=>bindMatterReferenceSearchTemplate({envelope:changed,definition:changedDefinition,matterReference:"P261830"}),/SLOT_REJECTED/);
});

test("keeps the verified internal identity out of the public context",()=>{
  const value=context();
  assert.deepEqual(value,{matterReference:"P261830-S1",sourceTemplateId:searchEnvelope.templateId,verified:true,internalIdentityIncluded:false});
  assert.doesNotMatch(JSON.stringify(value),/another-private-key/);
  const compiled=bindMatterIdentityDetailTemplate({envelope:detailEnvelope,definition:detailDefinition,context:value});
  assert.deepEqual(collectLiteralEqualities(compiled.statements[0]),[{column:"idx",literal:"another-private-key"}]);
});

test("keeps only one exact reference from a bounded LIKE candidate set",()=>{
  const value=createMatterIdentityContext({matterReference:"P261830",definition:searchDefinition,searchResult:{
    templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:[{idx:"exact-private-key",ourref:"P261830"},{idx:"partial-private-key",ourref:"P261830-PRO1"}],
  }});
  const compiled=bindMatterIdentityDetailTemplate({envelope:detailEnvelope,definition:detailDefinition,context:value});
  assert.deepEqual(collectLiteralEqualities(compiled.statements[0]),[{column:"idx",literal:"exact-private-key"}]);
  assert.doesNotMatch(JSON.stringify(value),/exact-private-key|partial-private-key/);
});

test("accepts only a positive bounded search candidate count",()=>{
  const definition={templateId:"matter-search.exact-count.v1",responseCountColumn:"recCount",expectedResponseColumns:["recCount"]};
  const result=value=>({templateId:definition.templateId,columns:["recCount"],rows:[{recCount:value}]});
  assert.equal(readMatterSearchCandidateCount({result:result("2"),definition}),2);
  for(const value of ["0","501","01","-1","x"])assert.throws(()=>readMatterSearchCandidateCount({result:result(value),definition}),/SEARCH_COUNT_REJECTED/);
});

test("quotes a server-origin identity without changing the statement structure",()=>{
  const suspicious="abc' OR 1=1--";
  const compiled=bindMatterIdentityDetailTemplate({envelope:detailEnvelope,definition:detailDefinition,context:context(suspicious)});
  assert.match(compiled.statements[0],/abc'' OR 1=1--'/);
  assert.deepEqual(collectLiteralEqualities(compiled.statements[0]),[{column:"idx",literal:suspicious}]);
});

test("binds a captured numeric internal-key predicate only to a canonical server-origin integer",()=>{
  const numericEnvelope={...detailEnvelope,statements:["SELECT idx, app_right FROM matters WHERE idx = 123456"]};
  const numericDefinition={...detailDefinition,baseFingerprint:fingerprintEnvelope(numericEnvelope),parameterization:{...detailDefinition.parameterization,mode:"single-scalar-equality"}};
  const compiled=bindMatterIdentityDetailTemplate({envelope:numericEnvelope,definition:numericDefinition,context:context("987654")});
  assert.match(compiled.statements[0],/idx = 987654$/);
  assert.throws(()=>bindMatterIdentityDetailTemplate({envelope:numericEnvelope,definition:numericDefinition,context:context("987654 OR 1=1")}),/PARAMETER_VALUE_REJECTED/);
});

test("binds several verified-identity predicates together without changing structure",()=>{
  const multiEnvelope={templateId:"matter-detail.related-counts.v1",command:"SELECT",statements:["SELECT * FROM counts WHERE idx_parent = 123 AND GRP_KEY = 123 AND idx_data = 123"]};
  const multiDefinition={templateId:multiEnvelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(multiEnvelope),productionEnabled:false,parameterization:{mode:"multi-scalar-equality",source:"verified-search-identity",predicateColumns:["idx_parent","GRP_KEY","idx_data"],sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"}};
  const compiled=bindMatterIdentityDetailTemplate({envelope:multiEnvelope,definition:multiDefinition,context:context("987654")});
  assert.deepEqual(collectLiteralEqualities(compiled.statements[0]),[{column:"idx_parent",literal:"987654"},{column:"GRP_KEY",literal:"987654"},{column:"idx_data",literal:"987654"}]);
  const inconsistent={...multiEnvelope,statements:[multiEnvelope.statements[0].replace("GRP_KEY = 123","GRP_KEY = 124")]};
  assert.throws(()=>bindMatterIdentityDetailTemplate({envelope:inconsistent,definition:{...multiDefinition,baseFingerprint:fingerprintEnvelope(inconsistent)},context:context("987654")}),/SLOT_REJECTED/);
});

test("binds explicitly counted repeated equality slots together",()=>{
  const envelope={templateId:"matter-detail.related-counts.v1",command:"SELECT",statements:["SELECT * FROM a WHERE idx_parent=123 UNION ALL SELECT * FROM b WHERE idx_parent=123 AND GRP_KEY=123 AND idx_data=123"]};
  const definition={templateId:envelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(envelope),productionEnabled:false,parameterization:{mode:"multi-scalar-equality",source:"verified-search-identity",predicateColumns:["idx_parent","GRP_KEY","idx_data"],expectedOccurrenceCounts:{idx_parent:2,GRP_KEY:1,idx_data:1},sourceTemplateId:searchEnvelope.templateId,sourceColumn:"idx"}};
  const compiled=bindMatterIdentityDetailTemplate({envelope,definition,context:context("987654")});
  assert.equal(collectLiteralEqualities(compiled.statements[0]).filter(item=>item.literal==="987654").length,4);
  assert.throws(()=>bindMatterIdentityDetailTemplate({envelope,definition:{...definition,parameterization:{...definition.parameterization,expectedOccurrenceCounts:{idx_parent:1,GRP_KEY:1,idx_data:1}}},context:context("987654")}),/SLOT_REJECTED/);
});

test("binds a trusted server-derived scalar without accepting a source identity declaration",()=>{
  const envelope={templateId:"matter-detail.document-group-intermediate.v2",command:"SELECT",statements:["SELECT idx, idx_parent FROM progress WHERE idx = 123"]};
  const definition={templateId:envelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(envelope),productionEnabled:false,parameterization:{mode:"single-scalar-equality",source:"trusted-derived-identity",predicateColumn:"idx"}};
  const compiled=bindTrustedDerivedScalarTemplate({envelope,definition,value:"987654"});
  assert.deepEqual(collectLiteralEqualities(compiled.statements[0]),[{column:"idx",literal:"987654"}]);
  assert.throws(()=>bindTrustedDerivedScalarTemplate({envelope,definition:{...definition,parameterization:{...definition.parameterization,sourceColumn:"idx"}},value:"987654"}),/DEFINITION_REJECTED/);
  assert.throws(()=>bindTrustedDerivedScalarTemplate({envelope,definition,value:"987654 OR 1=1"}),/PARAMETER_VALUE_REJECTED/);
});

test("can safely quote a trusted server-derived scalar captured originally as a number",()=>{
  const envelope={templateId:"matter-detail.documents.v1",command:"SELECT",statements:["SELECT GRP_KEY FROM docs WHERE GRP_KEY = 123"]};
  const definition={templateId:envelope.templateId,command:"SELECT",statementCount:1,baseFingerprint:fingerprintEnvelope(envelope),productionEnabled:false,parameterization:{mode:"scalar-equality-as-literal",source:"trusted-derived-identity",predicateColumn:"GRP_KEY"}};
  const compiled=bindTrustedDerivedScalarTemplate({envelope,definition,value:"group-A'1"});
  assert.equal(compiled.statements[0],"SELECT GRP_KEY FROM docs WHERE GRP_KEY = 'group-A''1'");
  assert.deepEqual(collectLiteralEqualities(compiled.statements[0]),[{column:"GRP_KEY",literal:"group-A'1"}]);
  const textEnvelope={...envelope,statements:["SELECT GRP_KEY FROM docs WHERE GRP_KEY = '123'"]};
  const textDefinition={...definition,baseFingerprint:fingerprintEnvelope(textEnvelope)};
  assert.equal(bindTrustedDerivedScalarTemplate({envelope:textEnvelope,definition:textDefinition,value:"위임계약서"}).statements[0],"SELECT GRP_KEY FROM docs WHERE GRP_KEY = N'위임계약서'");
});

test("rejects changed bases, ambiguous slots, and a forged identity context",()=>{
  const changed={...searchEnvelope,statements:[searchEnvelope.statements[0].replace("matters","other_table")]};
  assert.throws(()=>bindMatterReferenceSearchTemplate({envelope:changed,definition:searchDefinition,matterReference:"P261830"}),/BASE_REJECTED/);
  const ambiguous={...searchEnvelope,statements:[searchEnvelope.statements[0]+" OR ourref = 'P261793'"]};
  const ambiguousDefinition={...searchDefinition,baseFingerprint:fingerprintEnvelope(ambiguous)};
  assert.throws(()=>bindMatterReferenceSearchTemplate({envelope:ambiguous,definition:ambiguousDefinition,matterReference:"P261830"}),/SLOT_REJECTED/);
  assert.throws(()=>bindMatterIdentityDetailTemplate({envelope:detailEnvelope,definition:detailDefinition,context:{...context()}}),/CONTEXT_REJECTED/);
});

test("requires one exact search row, schema, reference, and non-credential identity",()=>{
  const base={templateId:searchEnvelope.templateId,columns:["idx","ourref"],rows:[{idx:"key",ourref:"P261830"}]};
  for(const changed of [
    {...base,rows:[]},
    {...base,rows:[...base.rows,...base.rows]},
    {...base,rows:[{idx:"key",ourref:"P261830-S1"}]},
    {...base,columns:["idx","ourref","pw"],rows:[{idx:"key",ourref:"P261830",pw:"secret"}]},
    {...base,columns:["IDX","idx","ourref"],rows:[{IDX:"a",idx:"b",ourref:"P261830"}]},
  ]) assert.throws(()=>createMatterIdentityContext({matterReference:"P261830",searchResult:changed,definition:searchDefinition}),/SEARCH_IDENTITY_REJECTED/);
});

test("rejects caller-like input that is not a supported full matter reference",()=>{
  assert.throws(()=>bindMatterReferenceSearchTemplate({envelope:searchEnvelope,definition:searchDefinition,matterReference:"P261830' OR 1=1--"}),/MATTER_REFERENCE_REJECTED/);
});
