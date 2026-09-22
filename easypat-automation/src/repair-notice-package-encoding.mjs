import {createHash,randomUUID} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import {copyFile,lstat,mkdir,readFile,readdir,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {normalizeExactMatterReference} from "./protocol/matter-reference.mjs";
import {createUtf8ZipArchive,inspectUtf8ZipBytes} from "./workflow/utf8-zip.mjs";

const projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url))),policy=JSON.parse(await readFile(path.join(projectRoot,"config","safety-policy.json"),"utf8")),destinationRoot=path.resolve(policy.noticePackageDownloadConstraints.destinationRoot);
const stagingRoot=path.join(projectRoot,".local","notice-packages"),correctionBase=path.join(projectRoot,".local","notice-package-corrections"),replaceScript=fileURLToPath(new URL("../scripts/Replace-VerifiedFile.ps1",import.meta.url)),powerShell=process.env.EASYPAT_PWSH_PATH||"pwsh.exe",tarCommand=path.join(process.env.SystemRoot||"C:\\Windows","System32","tar.exe");
const dbPath=process.env.SSPAT_WORK_DB_PATH?path.resolve(process.env.SSPAT_WORK_DB_PATH):path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local"),"SSPAT","work-management","sspat-work.db");
function input(){const matterIndex=process.argv.indexOf("--matter-reference"),sequenceIndex=process.argv.indexOf("--oa-sequence");if(matterIndex<0||sequenceIndex<0)throw new Error("ENCODING_REPAIR_INPUT_REJECTED");const matterReference=normalizeExactMatterReference(process.argv[matterIndex+1]),oaSequence=Number(process.argv[sequenceIndex+1]);if(!Number.isInteger(oaSequence)||oaSequence<1||oaSequence>50)throw new Error("ENCODING_REPAIR_INPUT_REJECTED");return{matterReference,oaSequence};}
function sha256(bytes){return createHash("sha256").update(bytes).digest("hex");}
async function hashFile(filePath){return sha256(await readFile(filePath));}
function inside(root,candidate){const relative=path.relative(root,candidate);return relative===""||relative!==".."&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);}
function run(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{shell:false,windowsHide:true,stdio:["ignore","ignore","ignore"]});child.on("error",()=>reject(new Error("ENCODING_REPAIR_COMMAND_FAILED")));child.on("close",code=>code===0?resolve():reject(new Error("ENCODING_REPAIR_COMMAND_FAILED")));});}
function transaction(db,action){db.exec("BEGIN IMMEDIATE");try{const result=action();db.exec("COMMIT");return result;}catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}}

async function findVerifiedSource(row,manifest){
  const directories=(await readdir(stagingRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith(`${row.matter_reference}-${row.notice_date}-`)).sort((a,b)=>b.name.localeCompare(a.name));
  for(const directory of directories){
    const archiveRoot=path.join(stagingRoot,directory.name,"archive"),manifestPath=path.join(archiveRoot,"download-manifest.json");
    try{
      const sourceManifest=JSON.parse(await readFile(manifestPath,"utf8"));if(sourceManifest.matterReference!==row.matter_reference||sourceManifest.noticeDate!==row.notice_date||sourceManifest.itemCount!==manifest.items.length)continue;
      let matches=true;for(const expected of manifest.items){const source=sourceManifest.items.find(item=>item.sourcePosition===expected.sourcePosition&&item.originalFileName===expected.fileName);if(!source||source.sha256!==expected.sha256||source.fileSizeBytes!==expected.fileSizeBytes){matches=false;break;}const candidate=path.resolve(archiveRoot,...expected.archiveEntry.split("/"));if(!inside(archiveRoot,candidate)){matches=false;break;}const info=await lstat(candidate);if(!info.isFile()||info.isSymbolicLink()||info.size!==expected.fileSizeBytes||await hashFile(candidate)!==expected.sha256){matches=false;break;}}
      if(matches)return archiveRoot;
    }catch{}
  }
  throw new Error("ENCODING_REPAIR_SOURCE_NOT_FOUND");
}

let db,stage="input";
try{
  const target=input();stage="ledger-open";db=new DatabaseSync(dbPath);db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  stage="ledger-read";const row=db.prepare(`SELECT n.id AS notice_id,n.notice_key,n.matter_reference,n.notice_date,n.due_date,n.oa_sequence,n.status AS notice_status,j.id AS job_id,j.attachment_version,j.status AS job_status,p.id AS package_id,p.package_version,p.file_name,p.destination_path,p.sha256,p.file_size_bytes,p.item_count,p.manifest_json FROM notice n JOIN download_job j ON j.notice_id=n.id JOIN download_package p ON p.download_job_id=j.id WHERE n.matter_reference=? COLLATE NOCASE AND n.notice_kind='opinion_submission' AND n.oa_sequence=? ORDER BY p.package_version DESC LIMIT 1`).get(target.matterReference,target.oaSequence);
  if(!row||row.notice_status!=="published"||row.job_status!=="published")throw new Error("ENCODING_REPAIR_LEDGER_REJECTED");
  stage="destination-path";const manifest=JSON.parse(row.manifest_json),entries=[...manifest.items.map(item=>item.archiveEntry),"download-manifest.json"],finalPath=path.join(destinationRoot,row.file_name);
  if(path.resolve(row.destination_path).toLocaleLowerCase("en-US")!==finalPath.toLocaleLowerCase("en-US"))throw new Error("ENCODING_REPAIR_DESTINATION_REJECTED");
  stage="destination-hash";const currentInfo=await lstat(finalPath);if(!currentInfo.isFile()||currentInfo.isSymbolicLink())throw new Error("ENCODING_REPAIR_DESTINATION_REJECTED");const currentBytes=await readFile(finalPath),currentSha=sha256(currentBytes),destinationMatchesLedger=currentBytes.length===row.file_size_bytes&&currentSha===row.sha256;
  if(manifest.encodingCorrection?.utf8FileNamesVerified===true){if(!destinationMatchesLedger)throw new Error("ENCODING_REPAIR_DESTINATION_REJECTED");inspectUtf8ZipBytes(currentBytes,{expectedEntries:entries});console.log(JSON.stringify({status:"already-corrected",matterReference:target.matterReference,oaSequence:target.oaSequence,fileName:row.file_name,sha256:row.sha256,itemCount:row.item_count}));process.exit(0);}
  stage="source-verify";const archiveRoot=await findVerifiedSource(row,manifest),legacySourcePath=path.join(path.dirname(archiveRoot),row.file_name),legacyBytes=await readFile(legacySourcePath);if(legacyBytes.length!==row.file_size_bytes||sha256(legacyBytes)!==row.sha256)throw new Error("ENCODING_REPAIR_SOURCE_NOT_FOUND");
  let oldEncodingAccepted=true;try{inspectUtf8ZipBytes(legacyBytes,{expectedEntries:entries});}catch{oldEncodingAccepted=false;}if(oldEncodingAccepted)throw new Error("ENCODING_REPAIR_NOT_REQUIRED");
  const correctionRoot=path.join(correctionBase,`${target.matterReference}-${row.notice_date}-${randomUUID()}`),validationRoot=path.join(correctionRoot,"validation");await mkdir(validationRoot,{recursive:true});
  stage="zip-create";const correctedPath=path.join(correctionRoot,row.file_name),zipInspection=await createUtf8ZipArchive({sourceRoot:archiveRoot,outputPath:correctedPath,entries});if(zipInspection.utf8FileNamesVerified!==true)throw new Error("ENCODING_REPAIR_ZIP_REJECTED");
  await run(tarCommand,["-xf",correctedPath,"-C",validationRoot]);for(const item of manifest.items){const extracted=path.resolve(validationRoot,...item.archiveEntry.split("/"));if(!inside(validationRoot,extracted))throw new Error("ENCODING_REPAIR_ZIP_REJECTED");const info=await lstat(extracted);if(!info.isFile()||info.isSymbolicLink()||info.size!==item.fileSizeBytes||await hashFile(extracted)!==item.sha256)throw new Error("ENCODING_REPAIR_ZIP_REJECTED");}
  const correctedInfo=await stat(correctedPath),correctedSha=await hashFile(correctedPath),backupPath=path.join(correctionRoot,`legacy-encoding-v${row.package_version}.zip`),observedPath=path.join(correctionRoot,"observed-before-correction.zip");await copyFile(legacySourcePath,backupPath,fsConstants.COPYFILE_EXCL);if(await hashFile(backupPath)!==row.sha256)throw new Error("ENCODING_REPAIR_BACKUP_REJECTED");await copyFile(finalPath,observedPath,fsConstants.COPYFILE_EXCL);if(await hashFile(observedPath)!==currentSha)throw new Error("ENCODING_REPAIR_BACKUP_REJECTED");
  stage="destination-replace";const temporaryPath=path.join(destinationRoot,`.${row.file_name}.${randomUUID()}.partial`);await copyFile(correctedPath,temporaryPath,fsConstants.COPYFILE_EXCL);if(await hashFile(temporaryPath)!==correctedSha)throw new Error("ENCODING_REPAIR_COPY_REJECTED");await run(powerShell,["-NoLogo","-NoProfile","-File",replaceScript,"-TemporaryPath",temporaryPath,"-DestinationPath",finalPath]);if(await hashFile(finalPath)!==correctedSha)throw new Error("ENCODING_REPAIR_REPLACE_REJECTED");
  stage="ledger-update";const timestamp=new Date().toISOString(),newPackageVersion=transaction(db,()=>{
    const current=db.prepare("SELECT p.id,p.sha256,p.destination_path FROM download_package p JOIN download_job j ON j.id=p.download_job_id WHERE p.id=? AND j.status='published'").get(row.package_id);if(!current||current.sha256!==row.sha256||path.resolve(current.destination_path).toLocaleLowerCase("en-US")!==finalPath.toLocaleLowerCase("en-US"))throw new Error("ENCODING_REPAIR_CONCURRENT_CHANGE");
    const packageVersion=Number(db.prepare("SELECT COALESCE(MAX(package_version),0)+1 AS n FROM download_job WHERE notice_id=?").get(row.notice_id).n),jobId=randomUUID(),packageId=randomUUID();
    db.prepare("UPDATE download_package SET destination_path=? WHERE id=?").run(backupPath,row.package_id);
    db.prepare(`INSERT INTO download_job(id,notice_id,attachment_version,package_version,expected_file_name,status,requested_at,started_at,completed_at,updated_at) VALUES (?,?,?,?,?,'published',?,?,?,?)`).run(jobId,row.notice_id,row.attachment_version,packageVersion,row.file_name,timestamp,timestamp,timestamp,timestamp);
    const correctedManifest=JSON.stringify({...manifest,encodingCorrection:{reason:"zip_entry_utf8",utf8FileNamesVerified:true,supersedesPackageVersion:row.package_version,previousSha256:row.sha256,observedBeforeCorrectionSha256:currentSha,observedDestinationMatchedLedger:destinationMatchesLedger,correctedAt:timestamp}});
    db.prepare(`INSERT INTO download_package(id,download_job_id,notice_id,package_version,file_name,destination_path,sha256,file_size_bytes,item_count,manifest_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(packageId,jobId,row.notice_id,packageVersion,row.file_name,finalPath,correctedSha,correctedInfo.size,row.item_count,correctedManifest,timestamp,timestamp);
    db.prepare("UPDATE notice SET status='published',row_version=row_version+1,updated_at=? WHERE id=?").run(timestamp,row.notice_id);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event'").get())db.prepare(`INSERT INTO event(id,entity_type,entity_id,event_type,before_json,after_json,actor,source_type,created_at) VALUES (?,'notice',?,'notice_package_encoding_corrected',?,?,'automation','system',?)`).run(randomUUID(),row.notice_id,JSON.stringify({packageVersion:row.package_version,ledgerSha256:row.sha256,observedSha256:currentSha,destinationMatchedLedger:destinationMatchesLedger}),JSON.stringify({packageVersion,sha256:correctedSha,utf8FileNamesVerified:true}),timestamp);
    return packageVersion;
  });
  console.log(JSON.stringify({status:"corrected",matterReference:target.matterReference,oaSequence:target.oaSequence,noticeDate:row.notice_date,dueDate:row.due_date,fileName:row.file_name,fileSizeBytes:correctedInfo.size,sha256:correctedSha,itemCount:row.item_count,utf8FileNamesVerified:true,previousPackageVersion:row.package_version,packageVersion:newPackageVersion,legacyPackagePreserved:true}));
}catch(error){console.error(JSON.stringify({status:"failed",stage,code:/^[A-Z0-9_-]+$/.test(error?.message??"")?error.message:"ENCODING_REPAIR_FAILED"}));process.exitCode=1;}finally{try{db?.close();}catch{}}
