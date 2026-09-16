import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createEasyPatRuntime} from "./runtime.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),attempt=path.join(root,"live-p261793-main-attempt.v1.json");let claimed=false;
try{
  await mkdir(root,{recursive:true});const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error();
  const startedAt=new Date().toISOString();await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"started",matterReference:"P261793",templateId:"matter-detail.main-record.v1",startedAt}),{flag:"wx",mode:0o600});claimed=true;
  const runtime=createEasyPatRuntime();if(runtime.status().liveReady!==true||runtime.status().sessionRefreshEnabled!==false)throw new Error();
  let result=await runtime.read({templateId:"matter-detail.main-record.v1",matterReference:"P261793"});const row=result.rows[0],nonEmptyFieldCount=result.columns.filter(column=>row[column]!==null&&row[column]!=="").length;
  const safe={status:"live-read-validated",matterReference:result.matterReference,templateId:result.templateId,rowCount:result.rows.length,columnCount:result.columns.length,columns:result.columns,nonEmptyFieldCount,exactMatterMatch:true,rawRowValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false};
  await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"success",matterReference:"P261793",templateId:"matter-detail.main-record.v1",startedAt,completedAt:new Date().toISOString()}),{mode:0o600});result=null;console.log(JSON.stringify(safe));
}catch{if(claimed){try{await writeFile(attempt,JSON.stringify({schemaVersion:1,status:"failed",matterReference:"P261793",templateId:"matter-detail.main-record.v1",completedAt:new Date().toISOString()}),{mode:0o600});}catch{}}console.error("LIVE_P261793_MAIN_READ_FAILED");process.exitCode=1;}
