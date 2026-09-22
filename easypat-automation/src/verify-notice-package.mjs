import {createHash} from "node:crypto";
import {existsSync} from "node:fs";
import {lstat,readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url))),policy=JSON.parse(await readFile(path.join(projectRoot,"config","safety-policy.json"),"utf8")),destinationRoot=path.resolve(policy.noticePackageDownloadConstraints.destinationRoot);
const dbPath=process.env.SSPAT_WORK_DB_PATH?path.resolve(process.env.SSPAT_WORK_DB_PATH):path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local"),"SSPAT","work-management","sspat-work.db");
function input(){const matterIndex=process.argv.indexOf("--matter-reference"),sequenceIndex=process.argv.indexOf("--oa-sequence");if(matterIndex<0||sequenceIndex<0)throw new Error("VERIFY_INPUT_REJECTED");const matterReference=normalizeExactMatterReference(process.argv[matterIndex+1]),oaSequence=Number(process.argv[sequenceIndex+1]);if(!Number.isSafeInteger(oaSequence)||oaSequence<1||oaSequence>50)throw new Error("VERIFY_INPUT_REJECTED");return{matterReference,oaSequence};}
function hash(bytes){return createHash("sha256").update(bytes).digest("hex");}
function listArchive(filePath){return new Promise((resolve,reject)=>{const child=spawn(path.join(process.env.SystemRoot||"C:\\Windows","System32","tar.exe"),["-tf",filePath],{shell:false,windowsHide:true,stdio:["ignore","pipe","ignore"]}),chunks=[];child.stdout.on("data",chunk=>chunks.push(Buffer.from(chunk)));child.on("error",()=>reject(new Error("VERIFY_ARCHIVE_REJECTED")));child.on("close",code=>code===0?resolve(Buffer.concat(chunks)):reject(new Error("VERIFY_ARCHIVE_REJECTED")));});}
function entries(bytes){const parse=value=>value.split(/\r?\n/u).filter(Boolean).map(item=>item.replace(/^\.\/+/,"").replaceAll("\\","/")).sort();return[parse(bytes.toString("utf8")),parse(new TextDecoder("euc-kr").decode(bytes))];}

let db,stage="input";
try{
  const target=input();if(!existsSync(dbPath))throw new Error("VERIFY_DATABASE_MISSING");stage="ledger-open";db=new DatabaseSync(dbPath,{readOnly:true});
  stage="ledger-package";
  const row=db.prepare(`SELECT n.notice_key,n.status AS notice_status,n.notice_date,n.due_date,n.oa_sequence,j.status AS job_status,j.attachment_version,p.file_name,p.destination_path,p.sha256,p.file_size_bytes,p.item_count,p.manifest_json FROM notice n JOIN download_job j ON j.notice_id=n.id JOIN download_package p ON p.download_job_id=j.id WHERE n.matter_reference=? COLLATE NOCASE AND n.notice_kind='opinion_submission' AND n.oa_sequence=? ORDER BY p.published_at DESC`).get(target.matterReference,target.oaSequence);
  if(!row||row.notice_status!=="published"||row.job_status!=="published")throw new Error("VERIFY_LEDGER_REJECTED");
  stage="destination-path";const expectedPath=path.join(destinationRoot,row.file_name);if(path.resolve(row.destination_path).toLocaleLowerCase("en-US")!==expectedPath.toLocaleLowerCase("en-US"))throw new Error("VERIFY_DESTINATION_REJECTED");
  stage="destination-file";
  const info=await lstat(expectedPath);if(!info.isFile()||info.isSymbolicLink()||info.size!==row.file_size_bytes)throw new Error("VERIFY_DESTINATION_REJECTED");
  const digest=hash(await readFile(expectedPath));if(digest!==row.sha256)throw new Error("VERIFY_HASH_REJECTED");
  stage="ledger-attachments";const manifest=JSON.parse(row.manifest_json),attachments=db.prepare("SELECT source_position,file_name,file_size_bytes,sha256,state FROM notice_attachment WHERE notice_id=(SELECT id FROM notice WHERE notice_key=?) AND attachment_version=? ORDER BY source_position").all(row.notice_key,row.attachment_version);
  if(attachments.length!==row.item_count||attachments.some((item,index)=>item.state!=="verified"||item.file_name!==manifest.items[index]?.fileName||item.file_size_bytes!==manifest.items[index]?.fileSizeBytes||item.sha256!==manifest.items[index]?.sha256))throw new Error("VERIFY_LEDGER_REJECTED");
  stage="archive-list";const expectedEntries=[...manifest.items.map(item=>item.archiveEntry),"download-manifest.json"].sort(),listed=entries(await listArchive(expectedPath));if(!listed.some(candidate=>JSON.stringify(candidate)===JSON.stringify(expectedEntries)))throw new Error("VERIFY_ARCHIVE_REJECTED");
  console.log(JSON.stringify({status:"verified",matterReference:target.matterReference,oaSequence:target.oaSequence,noticeDate:row.notice_date,dueDate:row.due_date,fileName:row.file_name,fileSizeBytes:row.file_size_bytes,sha256:digest,itemCount:row.item_count,noticeStatus:row.notice_status,jobStatus:row.job_status,archiveEntriesVerified:true,ledgerAttachmentsVerified:true}));
}catch(error){const safeCode=/^[A-Z0-9_-]+$/.test(error?.message??"")?error.message:/^[A-Z0-9_-]+$/.test(error?.code??"")?error.code:"VERIFY_FAILED";console.error(JSON.stringify({status:"failed",stage,code:safeCode,errorName:typeof error?.name==="string"?error.name:"Error"}));process.exitCode=1;}finally{try{db?.close();}catch{}}
