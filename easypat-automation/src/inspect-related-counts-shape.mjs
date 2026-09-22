import {readFileSync} from "node:fs";
import {scanAuthenticationSql} from "./protocol/authentication-shape.mjs";
import {createTemplateStore} from "./security/template-store.mjs";

const observations=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8"));
const candidate=observations.candidates.find(item=>item.templateId==="matter-detail.related-counts.v1");
const searchCount=observations.candidates.find(item=>item.templateId==="matter-search.exact-count.v1");
const searchRows=observations.candidates.find(item=>item.templateId==="matter-search.exact-result.v1");
const matterDocuments=JSON.parse(readFileSync(new URL("../.local/templates-user/matter-document-request-session9.v1.json",import.meta.url),"utf8"));
const progressDocuments=JSON.parse(readFileSync(new URL("../.local/templates-user/progress-document-list-request.v1.json",import.meta.url),"utf8"));

try{
  if(!candidate||candidate.command!=="SELECT"||candidate.statementCount!==1)throw new Error("RELATED_COUNTS_TEMPLATE_REJECTED");
  const store=createTemplateStore({candidates:[candidate,searchCount,searchRows,matterDocuments,progressDocuments]});
  const templates=[];
  for(const metadata of [searchCount,searchRows,candidate,matterDocuments,progressDocuments]){
    const envelope=await store.load(metadata.templateId),inspected=scanAuthenticationSql(envelope.statements[0]);
    templates.push({templateId:metadata.templateId,shape:inspected.shape,literalCount:inspected.literalCount});
  }
  console.log(JSON.stringify({
    status:"attachment-template-shapes-inspected",
    templates,
    rawStatementReturned:false,
    literalValuesReturned:false,
    serverRequestsPerformed:0,
    executable:false,
  }));
}catch{
  console.error(JSON.stringify({
    status:"related-counts-shape-inspection-failed",
    rawStatementReturned:false,
    literalValuesReturned:false,
    serverRequestsPerformed:0,
    executable:false,
  }));
  process.exitCode=1;
}
