import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyPatRuntime } from "./runtime.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const attempt=path.join(root,"read-p261793-progress-attempt.v1.json");
let claimed=false,startedAt;
try{
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  const runtime=createEasyPatRuntime();const status=runtime.status();
  if(status.liveReady!==true||status.enabledTemplateCount!==3||status.sessionRefreshEnabled!==false||!status.allowedOperations.includes("list-progress"))throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"list-progress",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const progress=await runtime.listProgress({templateId:"matter-detail.progress-records.v1",matterReference:"P261793"});
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"list-progress",matterReference:"P261793",startedAt,completedAt:new Date().toISOString(),itemCount:progress.count}),{mode:0o600});
  console.log(JSON.stringify({status:"progress-list-read",progress,automaticRetryPerformed:false,serverMutationPerformed:false,rawRowsReturned:false,internalIdentitiesReturned:false}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"list-progress",matterReference:"P261793",startedAt,completedAt:new Date().toISOString()}),{mode:0o600});}catch{}}console.error("P261793_PROGRESS_READ_FAILED");process.exitCode=1;}
