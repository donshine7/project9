import {readFile} from "node:fs/promises";
import {createTemplateStore} from "./security/template-store.mjs";
import {diagnoseDocumentRequest} from "./protocol/document-request-diagnostic.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";

let stage="metadata";
try{
  const legacy=process.argv.length===3&&process.argv[2]==="--legacy-v1";
  if(process.argv.length!==2&&!legacy)throw new Error();
  const metadataFile=legacy?"document-group-intermediate-request.v1.json":capture.requestMetadataFile;
  const templateId=legacy?"matter-detail.document-group-intermediate.v1":capture.templateId;
  const metadata=JSON.parse(await readFile(new URL("../.local/templates-user/"+metadataFile,import.meta.url),"utf8"));
  if(metadata.templateId!==templateId||metadata.command!=="SELECT"||metadata.statementCount!==1||metadata.productionEnabled!==false)throw new Error();
  stage="decrypt-request";const envelope=await createTemplateStore({candidates:[metadata]}).load(metadata.templateId);
  console.log(JSON.stringify({status:"stored-document-request-diagnosed",...diagnoseDocumentRequest(envelope.statements[0]),fingerprintVerified:true,serverRequestsPerformed:0}));
}catch{console.error(JSON.stringify({status:"stored-document-request-diagnostic-failed",failureStage:stage,rawValuesReturned:false,serverRequestsPerformed:0}));process.exitCode=1;}
