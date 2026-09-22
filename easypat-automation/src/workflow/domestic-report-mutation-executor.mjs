import {createHash} from "node:crypto";
import {lstat,readFile,realpath} from "node:fs/promises";
import path from "node:path";
import {buildDomesticReportMultipartUpload,EASYPAT_MUTATION_ENDPOINT,EASYPAT_UPLOAD_ENDPOINT} from "../protocol/domestic-report-mutation-transport.mjs";
import {parseHistoryAcknowledgements,parseIntegerAcknowledgement,parseProgressIdentityResponse} from "../protocol/jbori-write-response.mjs";
import {compileAttachmentInsert,compileHistoryBatch,compileProgressInsertBatch} from "../protocol/domestic-report-upload-mutation-template.mjs";
import {parseDomesticReportUploadResponse} from "../protocol/domestic-report-upload-response.mjs";

export class DomesticReportMutationExecutorError extends Error{constructor(code){super(code);this.name="DomesticReportMutationExecutorError";this.code=code;}}
const reject=code=>{throw new DomesticReportMutationExecutorError(code);};
const exactKeys=(value,required)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===[...required].sort().join(",");
function form(envelope){const values={connection:"EASYPAT_S_SSPAT",count:String(envelope.statements.length),command:envelope.command};envelope.statements.forEach((statement,index)=>{values[envelope.statements.length===1?"sql":`sql${index}`]=statement;});return new URLSearchParams(values).toString();}

export function createDomesticReportMutationExecutor({loadMutationTemplate,getSessionCookie,resolveMatterIdentity,transport,parseUploadResponse=parseDomesticReportUploadResponse,verifyReadBack}={}){
  if(typeof loadMutationTemplate!=="function"||typeof getSessionCookie!=="function"||typeof resolveMatterIdentity!=="function"||typeof transport!=="function"||typeof parseUploadResponse!=="function"||typeof verifyReadBack!=="function")throw new Error("DOMESTIC_REPORT_MUTATION_PROVIDER_REJECTED");
  return async input=>{
    if(!exactKeys(input,["matterReference","reportDate","assignee","reportDocument","fileName","fileSizeBytes","sha256","contentType","localFilePath"])||input.contentType!=="application/pdf"||typeof input.sha256!=="string"||!/^[a-f0-9]{64}$/.test(input.sha256))reject("DOMESTIC_REPORT_MUTATION_INPUT_REJECTED");
    let bytes,cookie,matterIdentity,progressIdentity,uploadedFileName;let stage="preflight";
    try{
      const info=await lstat(input.localFilePath),real=path.resolve(await realpath(input.localFilePath));if(!info.isFile()||info.isSymbolicLink()||real.toLowerCase()!==path.resolve(input.localFilePath).toLowerCase()||info.size!==input.fileSizeBytes)reject("DOMESTIC_REPORT_MUTATION_FILE_REJECTED");bytes=await readFile(real);if(bytes.length!==input.fileSizeBytes||!bytes.subarray(0,5).equals(Buffer.from("%PDF-"))||createHash("sha256").update(bytes).digest("hex")!==input.sha256)reject("DOMESTIC_REPORT_MUTATION_FILE_REJECTED");
      stage="resolve-matter";matterIdentity=await resolveMatterIdentity({matterReference:input.matterReference});if(typeof matterIdentity!=="string"||!/^(?:0|[1-9]\d{0,18})$/.test(matterIdentity))reject("DOMESTIC_REPORT_MUTATION_MATTER_REJECTED");
      const [progressBase,attachmentBase,historyBase]=await Promise.all([loadMutationTemplate("matter-progress.insert-batch.v1"),loadMutationTemplate("matter-progress.attach-insert.v1"),loadMutationTemplate("matter-progress.history-batch.v1")]);cookie=await getSessionCookie();
      stage="insert-progress";const progress=compileProgressInsertBatch({envelope:progressBase,matterIdentity,reportDate:input.reportDate,assignee:input.assignee,reportDocument:input.reportDocument});let response=await transport({endpoint:EASYPAT_MUTATION_ENDPOINT,body:form(progress),contentType:"application/x-www-form-urlencoded; charset=utf-8",cookie});progressIdentity=parseProgressIdentityResponse(response);response=null;
      stage="upload-file";const upload=buildDomesticReportMultipartUpload({fileName:input.fileName,bytes});response=await transport({endpoint:EASYPAT_UPLOAD_ENDPOINT,body:upload.body,contentType:upload.contentType,cookie});const parsedUpload=await parseUploadResponse(response,{expectedFileName:input.fileName});response?.bytes?.fill(0);response=null;if(!parsedUpload||typeof parsedUpload.uploadedFileName!=="string")reject("DOMESTIC_REPORT_UPLOAD_RESPONSE_REJECTED");uploadedFileName=parsedUpload.uploadedFileName;
      stage="insert-attachment";const attachment=compileAttachmentInsert({envelope:attachmentBase,matterIdentity,progressIdentity,assignee:input.assignee,fileName:input.fileName,fileSizeBytes:input.fileSizeBytes,uploadedFileName});response=await transport({endpoint:EASYPAT_MUTATION_ENDPOINT,body:form(attachment),contentType:"application/x-www-form-urlencoded; charset=utf-8",cookie});parseIntegerAcknowledgement(response);response=null;
      stage="insert-history";const history=compileHistoryBatch({envelope:historyBase,matterIdentity,progressIdentity,reportDate:input.reportDate,assignee:input.assignee,reportDocument:input.reportDocument});response=await transport({endpoint:EASYPAT_MUTATION_ENDPOINT,body:form(history),contentType:"application/x-www-form-urlencoded; charset=utf-8",cookie});parseHistoryAcknowledgements(response);response=null;
      stage="verify-read-back";const verified=await verifyReadBack({matterReference:input.matterReference,progressIdentity,reportDate:input.reportDate,assignee:input.assignee,reportDocument:input.reportDocument,fileName:input.fileName,fileSizeBytes:input.fileSizeBytes});if(verified?.verified!==true)reject("DOMESTIC_REPORT_MUTATION_READBACK_REJECTED");
      return Object.freeze({status:"verified",matterReference:input.matterReference,reportDate:input.reportDate,assignee:input.assignee,reportDocument:input.reportDocument,fileName:input.fileName,fileSizeBytes:input.fileSizeBytes});
    }catch(error){if(error instanceof DomesticReportMutationExecutorError)throw error;throw new DomesticReportMutationExecutorError(`DOMESTIC_REPORT_MUTATION_${stage.toUpperCase().replaceAll("-","_")}_FAILED`);}finally{bytes?.fill(0);bytes=null;cookie=null;matterIdentity=null;progressIdentity=null;uploadedFileName=null;}
  };
}
