import {createHash,randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {normalizeExactMatterReference} from "../protocol/matter-reference.mjs";

const defaultDbPath=process.env.SSPAT_WORK_DB_PATH?path.resolve(process.env.SSPAT_WORK_DB_PATH):path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local"),"SSPAT","work-management","sspat-work.db");
function now(){return new Date().toISOString();}
function noticeIdentity(input){return`notice_${createHash("sha256").update(["notice-v1",input.matterReference,"opinion_submission",input.sequence??"",input.noticeDate].join("|")).digest("hex")}`;}
function openDb(dbPath){if(!existsSync(dbPath))throw new Error("NOTICE_LEDGER_DATABASE_MISSING");const db=new DatabaseSync(dbPath);db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");for(const table of ["matter","notice","notice_attachment","download_job","download_package"]){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)){db.close();throw new Error("NOTICE_LEDGER_SCHEMA_MISSING");}}return db;}
function transaction(db,action){db.exec("BEGIN IMMEDIATE");try{const result=action();db.exec("COMMIT");return result;}catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}}
function createMatter(db,matterReference,timestamp,sourceId){
  if(!/^P\d{6}$/.test(matterReference))throw new Error("NOTICE_LEDGER_MATTER_MISSING");
  const id=randomUUID();
  db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,parent_ref,relation_type,suffixes_json,source_type,source_id,confidence,user_confirmed,created_at,updated_at) VALUES (?,?,'상상특허','domestic_patent','KR',?,NULL,NULL,'[]','easy_pat',?,1,0,?,?)`).run(id,matterReference,matterReference,sourceId,timestamp,timestamp);
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_observation'").get())db.prepare(`INSERT INTO source_observation(id,entity_type,entity_id,field_path,observed_value_json,source_type,source_id,observed_at,confidence,user_confirmed) VALUES (?,'matter',?,'our_ref',?,'easy_pat',?,?,1,0)`).run(randomUUID(),id,JSON.stringify(matterReference),sourceId,timestamp);
  return id;
}

export function beginNoticeDownload(input,{dbPath=defaultDbPath}={}){
  let matterReference;try{matterReference=normalizeExactMatterReference(input?.matterReference);}catch{throw new Error("NOTICE_LEDGER_INPUT_REJECTED");}
  if(!input||input.noticeKind!=="opinion_submission"||!Number.isInteger(input.oaSequence)||input.oaSequence<1||!/^\d{4}-\d{2}-\d{2}$/.test(input.noticeDate??"")||!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate??"")||typeof input.expectedFileName!=="string"||!Array.isArray(input.items)||input.items.length<1)throw new Error("NOTICE_LEDGER_INPUT_REJECTED");
  const db=openDb(dbPath),timestamp=now(),noticeKey=noticeIdentity({...input,matterReference});
  try{return transaction(db,()=>{
    let matter=db.prepare("SELECT id FROM matter WHERE our_ref=? COLLATE NOCASE AND archived_at IS NULL").get(matterReference);
    const sourceId=`notice:${matterReference}:${input.noticeDate}`;if(!matter)matter={id:createMatter(db,matterReference,timestamp,sourceId)};
    let notice=db.prepare("SELECT id,status FROM notice WHERE notice_key=?").get(noticeKey);
    if(notice?.status==="published"&&db.prepare("SELECT 1 FROM download_package WHERE notice_id=?").get(notice.id))return{duplicate:true,noticeId:notice.id,noticeKey};
    const noticeId=notice?.id??randomUUID(),evidence=JSON.stringify({source:"easy_pat",progressDocument:"의견제출통지서",aggregateAttachmentCount:input.aggregateAttachmentCount,attachmentCount:input.items.length});
    if(!notice)db.prepare(`INSERT INTO notice(id,notice_key,matter_id,matter_reference,notice_kind,identity_basis,progress_sequence,notice_date,due_date,oa_sequence,status,evidence_json,created_at,updated_at) VALUES (?,?,?,?, 'opinion_submission','progress_sequence_and_notice_date',?,?,?,?,'downloading',?,?,?)`).run(noticeId,noticeKey,matter.id,matterReference,input.sequence??null,input.noticeDate,input.dueDate,input.oaSequence,evidence,timestamp,timestamp);
    else db.prepare("UPDATE notice SET status='downloading',due_date=?,oa_sequence=?,evidence_json=?,row_version=row_version+1,updated_at=? WHERE id=?").run(input.dueDate,input.oaSequence,evidence,timestamp,noticeId);
    db.prepare("UPDATE download_job SET status='failed',error_code='SUPERSEDED_RETRY',completed_at=?,updated_at=? WHERE notice_id=? AND status IN ('queued','running','staged','verified')").run(timestamp,timestamp,noticeId);
    const attachmentVersion=Number(db.prepare("SELECT COALESCE(MAX(attachment_version),0)+1 AS n FROM notice_attachment WHERE notice_id=?").get(noticeId).n),packageVersion=Number(db.prepare("SELECT COALESCE(MAX(package_version),0)+1 AS n FROM download_job WHERE notice_id=?").get(noticeId).n),jobId=randomUUID();
    for(const item of input.items)db.prepare(`INSERT INTO notice_attachment(id,notice_id,attachment_version,source_position,document_name,registered_at,file_name,file_size_bytes,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'listed',?,?)`).run(randomUUID(),noticeId,attachmentVersion,item.position,item.documentName??null,item.registeredAt??null,item.fileName,item.fileSizeBytes,timestamp,timestamp);
    db.prepare(`INSERT INTO download_job(id,notice_id,attachment_version,package_version,expected_file_name,status,lock_token,requested_at,started_at,updated_at) VALUES (?,?,?,?,?,'running',?,?,?,?)`).run(jobId,noticeId,attachmentVersion,packageVersion,input.expectedFileName,randomUUID(),timestamp,timestamp,timestamp);
    return{duplicate:false,noticeId,noticeKey,jobId,attachmentVersion,packageVersion,dbPath};
  });}finally{db.close();}
}

export function failNoticeDownload(context,code,{dbPath=context?.dbPath??defaultDbPath}={}){
  if(!context?.jobId||!/^[A-Z0-9_-]+$/.test(code??""))return;
  const db=openDb(dbPath),timestamp=now();try{transaction(db,()=>{db.prepare("UPDATE download_job SET status='failed',error_code=?,completed_at=?,updated_at=? WHERE id=? AND status<>'published'").run(code,timestamp,timestamp,context.jobId);db.prepare("UPDATE notice SET status='failed',row_version=row_version+1,updated_at=? WHERE id=? AND status<>'published'").run(timestamp,context.noticeId);});}finally{db.close();}
}

export function completeNoticeDownload(context,result,{dbPath=context?.dbPath??defaultDbPath}={}){
  if(!context?.jobId||result?.published!==true||!Array.isArray(result.items)||result.items.length<1)throw new Error("NOTICE_LEDGER_INPUT_REJECTED");
  const db=openDb(dbPath),timestamp=now();try{return transaction(db,()=>{
    for(const item of result.items)db.prepare(`UPDATE notice_attachment SET sha256=?,state='verified',updated_at=? WHERE notice_id=? AND attachment_version=? AND source_position=? AND file_name=?`).run(item.sha256,timestamp,context.noticeId,context.attachmentVersion,item.sourcePosition,item.originalFileName);
    const manifest=JSON.stringify({schemaVersion:1,noticeKey:context.noticeKey,items:result.items.map(item=>({sourcePosition:item.sourcePosition,fileName:item.originalFileName,fileSizeBytes:item.fileSizeBytes,sha256:item.sha256,archiveEntry:item.archiveEntry}))});
    db.prepare(`INSERT INTO download_package(id,download_job_id,notice_id,package_version,file_name,destination_path,sha256,file_size_bytes,item_count,manifest_json,published_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),context.jobId,context.noticeId,context.packageVersion,result.expectedFileName,result.destinationPath,result.sha256,result.fileSizeBytes,result.itemCount,manifest,timestamp,timestamp);
    db.prepare("UPDATE download_job SET status='published',completed_at=?,updated_at=? WHERE id=?").run(timestamp,timestamp,context.jobId);db.prepare("UPDATE notice SET status='published',row_version=row_version+1,updated_at=? WHERE id=?").run(timestamp,context.noticeId);
    return{noticeKey:context.noticeKey,noticeId:context.noticeId,jobId:context.jobId,packageVersion:context.packageVersion};
  });}finally{db.close();}
}
