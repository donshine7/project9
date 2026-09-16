import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyPatRuntime } from "./runtime.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"read-p261793-documents-attempt.v1.json");let claimed=false,startedAt;
try{
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();const runtime=createEasyPatRuntime(),status=runtime.status();if(status.liveReady!==true||status.enabledTemplateCount!==3||status.sessionRefreshEnabled!==false||!status.allowedOperations.includes("list-documents"))throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"list-documents",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;const documents=await runtime.listDocuments({templateId:"matter-detail.documents.v1",matterReference:"P261793"});await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"list-documents",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),itemCount:documents.count}),{mode:0o600});console.log(JSON.stringify({status:"document-list-read",documents,contextBinding:"captured-p261793-fixed-document-group",automaticRetryPerformed:false,serverMutationPerformed:false,rawRowsReturned:false,uploadPathsReturned:false,internalIdentitiesReturned:false}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"list-documents",matterReference:"P261793",startedAt,completedAt:new Date().toISOString()}),{mode:0o600});}catch{}}console.error("P261793_DOCUMENT_LIST_READ_FAILED");process.exitCode=1;}
