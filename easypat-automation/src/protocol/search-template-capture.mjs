import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { fingerprintEnvelope } from "./template-fingerprint.mjs";
import { bindMatterReferenceSearchTemplate } from "./parameterized-read-template.mjs";

const SPECS=Object.freeze([
  Object.freeze({input:"countBody",templateId:"matter-search.exact-count.v1",sessionId:117,role:"count-results"}),
  Object.freeze({input:"resultBody",templateId:"matter-search.exact-result.v1",sessionId:119,role:"fetch-result-rows"}),
]);

function sqlFromForm(body){
  if(typeof body!=="string"||!body.length||Buffer.byteLength(body)>64*1024)throw new Error("SEARCH_CAPTURE_REJECTED");
  const form=new URLSearchParams(body),keys=[...form.keys()];
  if(keys.length!==4||["connection","count","command","sql"].some(key=>form.getAll(key).length!==1)||
     form.get("connection")!=="EASYPAT_S_SSPAT"||form.get("count")!=="1"||form.get("command")!=="SELECT"){
    throw new Error("SEARCH_CAPTURE_REJECTED");
  }
  return form.get("sql");
}

function definition(envelope){
  return {
    templateId:envelope.templateId,command:"SELECT",statementCount:1,
    baseFingerprint:fingerprintEnvelope(envelope),productionEnabled:false,
    parameterization:{mode:"repeated-like-contains",source:"matter-reference",predicateColumn:"ourref",baseMatterReference:"P261793",expectedOccurrenceCount:4},
  };
}

export function inspectCapturedSearchForms(input){
  if(!input||Object.keys(input).sort().join(",")!=="countBody,resultBody")throw new Error("SEARCH_CAPTURE_REJECTED");
  const items=SPECS.map(spec=>{
    const sql=sqlFromForm(input[spec.input]);
    if(spec.role==="count-results"&&!/^\s*SELECT\s+count\s*\(\s*\*\s*\)\s+AS\s+'recCount'\s+from\s+\(/i.test(sql))throw new Error("SEARCH_CAPTURE_REJECTED");
    if(spec.role==="fetch-result-rows"&&!/^\s*SELECT\s+idx\s*,/i.test(sql))throw new Error("SEARCH_CAPTURE_REJECTED");
    if((sql.match(/\bUNION\s+ALL\b/gi)??[]).length!==3)throw new Error("SEARCH_CAPTURE_REJECTED");
    const envelope={templateId:spec.templateId,command:"SELECT",statements:[sql]};
    createReadOnlyBatch([envelope]);
    const registered=definition(envelope);
    // A different full reference must compile through all four observed LIKE
    // slots before the capture is eligible for encrypted local storage.
    bindMatterReferenceSearchTemplate({envelope,definition:registered,matterReference:"P999999-S1"});
    return Object.freeze({spec,envelope:Object.freeze({...envelope,statements:Object.freeze([...envelope.statements])}),definition:Object.freeze(registered)});
  });
  return Object.freeze(items);
}

export function summarizeCapturedSearchForms(items){
  if(!Array.isArray(items)||items.length!==2)throw new Error("SEARCH_CAPTURE_REJECTED");
  return Object.freeze({
    status:"search-templates-inspected",
    templates:Object.freeze(items.map(item=>Object.freeze({
      sessionId:item.spec.sessionId,templateId:item.spec.templateId,role:item.spec.role,
      fingerprint:item.definition.baseFingerprint,statementCount:1,repeatedLikeOccurrenceCount:4,
    }))),
    rawStatementsReturned:false,
    plaintextWritten:false,
    executable:false,
  });
}
