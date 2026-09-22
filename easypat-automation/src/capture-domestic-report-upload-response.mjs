import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {inspectCapturedDomesticReportUploadResponse} from "./protocol/domestic-report-upload-response.mjs";

const chunks=[];let total=0,raw=null;const expectedFileName=process.argv[2];
try{
  for await(const chunk of process.stdin){total+=chunk.length;if(total>4096)throw new Error();chunks.push(chunk);}
  raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));const capture=inspectCapturedDomesticReportUploadResponse({raw,expectedFileName});
  const root=fileURLToPath(new URL("../.local/templates-user/",import.meta.url)),target=path.join(root,"domestic-report-upload-response.json"),metadata={schemaVersion:1,status:"captured",...capture,plaintextStored:false,productionEnabled:false};
  try{await writeFile(target,JSON.stringify(metadata),{flag:"wx",mode:0o600});}catch(error){if(error?.code!=="EEXIST"||JSON.stringify(JSON.parse(await readFile(target,"utf8")))!==JSON.stringify(metadata))throw error;}
  console.log(JSON.stringify({status:"domestic-report-upload-response-captured",contentType:capture.contentType,chunkedTransferCaptured:true,relativePathPatternVerified:true,extension:capture.extension,rawPathReturned:false,plaintextStored:false,serverRequestsPerformed:0,productionEnabled:false}));
}catch{console.error(JSON.stringify({status:"domestic-report-upload-response-rejected",rawPathReturned:false,plaintextStored:false,serverRequestsPerformed:0,productionEnabled:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));raw=null;}
