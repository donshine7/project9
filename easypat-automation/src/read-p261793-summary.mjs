import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEasyPatRuntime } from "./runtime.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url)));
const attempt=path.join(root,"live-p261793-summary-attempt.v1.json");
let claimed=false,startedAt;
try{
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  const runtime=createEasyPatRuntime();if(runtime.status().liveReady!==true||runtime.status().enabledTemplateCount!==3||runtime.status().sessionRefreshEnabled!==false)throw new Error();
  startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",operation:"get-matter-summary",matterReference:"P261793",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const summary=await runtime.readMatterSummary({templateId:"matter-detail.main-record.v1",matterReference:"P261793"});
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",operation:"get-matter-summary",matterReference:"P261793",startedAt,completedAt:new Date().toISOString()}),{mode:0o600});
  console.log(JSON.stringify({status:"matter-summary-read",summary,automaticRetryPerformed:false,serverMutationPerformed:false,rawRowReturned:false,internalIdentityReturned:false}));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",operation:"get-matter-summary",matterReference:"P261793",startedAt,completedAt:new Date().toISOString()}),{mode:0o600});}catch{}}console.error("P261793_SUMMARY_READ_FAILED");process.exitCode=1;}
