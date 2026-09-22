import {readFile} from "node:fs/promises";
import {inspectRelatedCountsBinding} from "./protocol/related-counts-binding.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

try{
  const candidates=JSON.parse(await readFile(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates,store=createTemplateStore({candidates});
  const [mainEnvelope,relatedEnvelope]=await Promise.all([store.load("matter-detail.main-record.v1"),store.load("matter-detail.related-counts.v1")]);
  console.log(JSON.stringify(inspectRelatedCountsBinding({mainEnvelope,relatedEnvelope})));
}catch{console.error(JSON.stringify({status:"related-counts-binding-diagnostic-failed",rawValuesReturned:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;}
