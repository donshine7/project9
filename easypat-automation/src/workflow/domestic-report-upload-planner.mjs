import {createHash,randomUUID} from "node:crypto";
import {lstat,mkdir,readFile,realpath} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {normalizeExactMatterReference} from "../protocol/matter-reference.mjs";

const projectRoot=fileURLToPath(new URL("../../",import.meta.url));
const defaultStagingRoot=path.join(projectRoot,".local","upload-staging");
const PDF_MAGIC=Buffer.from("%PDF-","ascii");
const SAFE_FILENAME=/^[^\\/:*?"<>|\x00-\x1f]{1,260}\.pdf$/iu;
const WINDOWS_DEVICE=/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const EVIDENCE_KEYS=Object.freeze(["assigneeLookupCaptured","domesticMatterClassificationCaptured","fileLinkCaptured","fileTransferCaptured","readBackVerificationCaptured","reportDocumentLookupCaptured","reportInsertCaptured","saveOrderCaptured"]);
const APPROVAL_BINDINGS=Object.freeze(["matterReference","reportDate","assignee","reportDocument","fileName","fileSizeBytes","sha256"]);

export class DomesticReportUploadError extends Error{
  constructor(code){super(code);this.name="DomesticReportUploadError";this.code=code;}
}

function exactKeys(input,required,optional=[]){
  if(!input||typeof input!=="object"||Array.isArray(input))return false;
  const keys=Object.keys(input),allowed=new Set([...required,...optional]);
  return required.every(key=>Object.hasOwn(input,key))&&keys.every(key=>allowed.has(key));
}

function localDate(timestamp){
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(timestamp);
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDate(value){
  if(typeof value!=="string"||!DATE.test(value))throw new DomesticReportUploadError("DOMESTIC_REPORT_DATE_REJECTED");
  const [year,month,day]=value.split("-").map(Number),date=new Date(Date.UTC(year,month-1,day));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)throw new DomesticReportUploadError("DOMESTIC_REPORT_DATE_REJECTED");
  return value;
}

function normalizeFileName(value){
  if(typeof value!=="string"||value!==value.trim()||!SAFE_FILENAME.test(value)||WINDOWS_DEVICE.test(value)||/[. ]$/.test(value)||path.win32.basename(value)!==value){
    throw new DomesticReportUploadError("DOMESTIC_REPORT_FILE_NAME_REJECTED");
  }
  return value;
}

function lower(value){return path.resolve(value).toLocaleLowerCase("en-US");}

async function inspectStagedPdf(root,fileName,maximumBytes){
  await mkdir(root,{recursive:true});
  const rootInfo=await lstat(root),rootReal=path.resolve(await realpath(root));
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||lower(rootReal)!==lower(root))throw new DomesticReportUploadError("DOMESTIC_REPORT_STAGING_REJECTED");
  const target=path.resolve(root,fileName);
  if(path.dirname(target)!==root)throw new DomesticReportUploadError("DOMESTIC_REPORT_FILE_NAME_REJECTED");
  let info,targetReal,bytes;
  try{info=await lstat(target);targetReal=path.resolve(await realpath(target));}
  catch{throw new DomesticReportUploadError("DOMESTIC_REPORT_FILE_NOT_FOUND");}
  if(!info.isFile()||info.isSymbolicLink()||lower(targetReal)!==lower(target)||!Number.isSafeInteger(info.size)||info.size<PDF_MAGIC.length||info.size>maximumBytes){
    throw new DomesticReportUploadError("DOMESTIC_REPORT_FILE_REJECTED");
  }
  bytes=await readFile(target);
  try{
    if(bytes.length!==info.size||!bytes.subarray(0,PDF_MAGIC.length).equals(PDF_MAGIC))throw new DomesticReportUploadError("DOMESTIC_REPORT_FILE_REJECTED");
    return Object.freeze({fileName,fileSizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),contentType:"application/pdf",path:target});
  }finally{bytes.fill(0);bytes=null;}
}

function validatePolicy(policy){
  const evidence=policy?.protocolEvidence;
  if(policy?.schemaVersion!==1||policy?.previewEnabled!==true||typeof policy?.commitEnabled!=="boolean"||typeof policy?.mcpExposureEnabled!=="boolean"||
     policy.mcpExposureEnabled!==policy.commitEnabled||policy.stagingRoot!==".local/upload-staging"||
     policy.defaults?.timezone!=="Asia/Seoul"||policy.defaults?.reportDate!=="today"||policy.defaults?.assignee!=="장진태"||
     JSON.stringify(policy.allowedAssignees)!==JSON.stringify(["장진태"])||
     JSON.stringify(policy.allowedReportDocuments)!==JSON.stringify(["특허 출원 진행 요청","의견서 및 보정서 제출 요청"])||
     policy.filePolicy?.maximumBytes!==67108864||JSON.stringify(policy.filePolicy?.allowedExtensions)!==JSON.stringify(["pdf"])||
     policy.filePolicy?.pdfMagicRequired!==true||policy.filePolicy?.symbolicLinksAllowed!==false||policy.filePolicy?.nestedPathsAllowed!==false||
     policy.approval?.required!==true||policy.approval?.ttlSeconds!==600||policy.approval?.singleUse!==true||JSON.stringify(policy.approval?.binds)!==JSON.stringify(APPROVAL_BINDINGS)||
     JSON.stringify(policy.duplicateKey)!==JSON.stringify(APPROVAL_BINDINGS)||
     policy.automaticRetryEnabled!==false||policy.overwriteAllowed!==false||policy.automaticRollbackEnabled!==false||
     policy.callerSuppliedSqlAllowed!==false||policy.callerSuppliedInternalIdentityAllowed!==false||policy.callerSuppliedServerPathAllowed!==false||
     !evidence||Object.keys(evidence).sort().join(",")!==[...EVIDENCE_KEYS].sort().join(",")||Object.values(evidence).some(value=>typeof value!=="boolean")||
     !Number.isInteger(policy.requiredDistinctLiveValidations)||!Number.isInteger(policy.completedDistinctLiveValidations)||
     !Array.isArray(policy.validatedMatterReferences)||new Set(policy.validatedMatterReferences).size!==policy.validatedMatterReferences.length||policy.validatedMatterReferences.length!==policy.completedDistinctLiveValidations){
    throw new Error("DOMESTIC_REPORT_UPLOAD_POLICY_REJECTED");
  }
  const evidenceComplete=Object.values(evidence).every(value=>value===true);
  if(policy.commitEnabled===true&&(policy.mcpExposureEnabled!==true||!evidenceComplete||policy.completedDistinctLiveValidations!==policy.requiredDistinctLiveValidations||policy.requiredDistinctLiveValidations<2)){
    throw new Error("DOMESTIC_REPORT_UPLOAD_POLICY_REJECTED");
  }
  return{evidenceComplete};
}

function duplicateFound(items,context){
  if(!Array.isArray(items)||items.length>500)throw new DomesticReportUploadError("DOMESTIC_REPORT_DUPLICATE_CHECK_REJECTED");
  return items.some(item=>item&&item.reportDate===context.reportDate&&item.assignee===context.assignee&&item.reportDocument===context.reportDocument&&
    (item.fileName===context.file.fileName||(typeof item.sha256==="string"&&item.sha256===context.file.sha256)));
}

export function createDomesticReportUploadPlanner({policy,verifyDomesticMatter,listExistingReports,executeMutation,stagingRoot=defaultStagingRoot,now=Date.now,issueApprovalId=randomUUID}={}){
  const fixed=structuredClone(policy),status=validatePolicy(fixed),root=path.resolve(stagingRoot),approvals=new Map();
  if(typeof verifyDomesticMatter!=="function"||typeof listExistingReports!=="function"||typeof now!=="function"||typeof issueApprovalId!=="function"||
     fixed.commitEnabled===true&&typeof executeMutation!=="function")throw new Error("DOMESTIC_REPORT_UPLOAD_PROVIDER_REJECTED");

  async function buildContext(input){
    if(!exactKeys(input,["matterReference","reportDocument","stagedFileName"],["reportDate","assignee"]))throw new DomesticReportUploadError("DOMESTIC_REPORT_UPLOAD_INPUT_REJECTED");
    let matterReference;
    try{matterReference=normalizeExactMatterReference(input.matterReference);}catch{throw new DomesticReportUploadError("DOMESTIC_REPORT_UPLOAD_INPUT_REJECTED");}
    const reportDateDefaulted=input.reportDate===undefined,assigneeDefaulted=input.assignee===undefined;
    const reportDate=normalizeDate(input.reportDate??localDate(now())),assignee=input.assignee??fixed.defaults.assignee;
    if(!fixed.allowedAssignees.includes(assignee))throw new DomesticReportUploadError("DOMESTIC_REPORT_ASSIGNEE_REJECTED");
    if(!fixed.allowedReportDocuments.includes(input.reportDocument))throw new DomesticReportUploadError("DOMESTIC_REPORT_DOCUMENT_REJECTED");
    const fileName=normalizeFileName(input.stagedFileName);
    const matter=await verifyDomesticMatter({matterReference});
    if(!matter||matter.matterReference!==matterReference||matter.domestic!==true||Object.keys(matter).sort().join(",")!=="domestic,matterReference"){
      throw new DomesticReportUploadError("DOMESTIC_REPORT_MATTER_REJECTED");
    }
    const file=await inspectStagedPdf(root,fileName,fixed.filePolicy.maximumBytes);
    const context={matterReference,reportDate,assignee,reportDocument:input.reportDocument,file,reportDateDefaulted,assigneeDefaulted};
    if(duplicateFound(await listExistingReports({matterReference}),context))throw new DomesticReportUploadError("DOMESTIC_REPORT_DUPLICATE_REJECTED");
    return context;
  }

  return Object.freeze({
    async preview(input){
      const context=await buildContext(input),commitEnabled=fixed.commitEnabled===true&&fixed.mcpExposureEnabled===true&&status.evidenceComplete;
      let approvalId=null,expiresAt=null;
      if(commitEnabled){approvalId=issueApprovalId();if(typeof approvalId!=="string"||!/^[A-Za-z0-9-]{16,128}$/.test(approvalId)||approvals.has(approvalId))throw new DomesticReportUploadError("DOMESTIC_REPORT_APPROVAL_REJECTED");expiresAt=now()+fixed.approval.ttlSeconds*1000;approvals.set(approvalId,{context,expiresAt});}
      return Object.freeze({status:commitEnabled?"approval-required":"protocol-capture-required",matterReference:context.matterReference,reportDate:context.reportDate,reportDateDefaulted:context.reportDateDefaulted,assignee:context.assignee,assigneeDefaulted:context.assigneeDefaulted,reportDocument:context.reportDocument,fileName:context.file.fileName,fileSizeBytes:context.file.fileSizeBytes,sha256:context.file.sha256,contentType:context.file.contentType,duplicate:false,approvalRequired:true,approvalId,expiresAt,commitEnabled,serverMutationPerformed:false,automaticRetryPerformed:false,rawFileContentReturned:false,localPathReturned:false});
    },
    async commit(input){
      if(!exactKeys(input,["approvalId"])||fixed.commitEnabled!==true||fixed.mcpExposureEnabled!==true||!status.evidenceComplete)throw new DomesticReportUploadError("DOMESTIC_REPORT_COMMIT_DISABLED");
      const approval=approvals.get(input.approvalId);approvals.delete(input.approvalId);
      if(!approval||approval.expiresAt<=now())throw new DomesticReportUploadError("DOMESTIC_REPORT_APPROVAL_REJECTED");
      const original=approval.context;
      try{
        const current=await buildContext({matterReference:original.matterReference,reportDate:original.reportDate,assignee:original.assignee,reportDocument:original.reportDocument,stagedFileName:original.file.fileName});
        if(current.file.sha256!==original.file.sha256||current.file.fileSizeBytes!==original.file.fileSizeBytes)throw new DomesticReportUploadError("DOMESTIC_REPORT_APPROVAL_STALE");
        const result=await executeMutation(Object.freeze({matterReference:current.matterReference,reportDate:current.reportDate,assignee:current.assignee,reportDocument:current.reportDocument,fileName:current.file.fileName,fileSizeBytes:current.file.fileSizeBytes,sha256:current.file.sha256,contentType:current.file.contentType,localFilePath:current.file.path}));
        if(!result||result.status!=="verified"||result.matterReference!==current.matterReference||result.reportDate!==current.reportDate||result.assignee!==current.assignee||result.reportDocument!==current.reportDocument||result.fileName!==current.file.fileName||result.fileSizeBytes!==current.file.fileSizeBytes){
          throw new DomesticReportUploadError("DOMESTIC_REPORT_COMMIT_VERIFICATION_REJECTED");
        }
        return Object.freeze({status:"uploaded-and-verified",matterReference:current.matterReference,reportDate:current.reportDate,assignee:current.assignee,reportDocument:current.reportDocument,fileName:current.file.fileName,fileSizeBytes:current.file.fileSizeBytes,sha256:current.file.sha256,serverMutationPerformed:true,readBackVerified:true,automaticRetryPerformed:false,automaticRollbackPerformed:false,internalIdentityReturned:false,serverPathReturned:false,rawFileContentReturned:false,localPathReturned:false});
      }catch(error){if(error instanceof DomesticReportUploadError)throw error;throw new DomesticReportUploadError("DOMESTIC_REPORT_COMMIT_FAILED");}
    },
    status:()=>Object.freeze({previewEnabled:true,commitEnabled:fixed.commitEnabled===true&&fixed.mcpExposureEnabled===true&&status.evidenceComplete,protocolEvidenceComplete:status.evidenceComplete,stagingRootConfigured:true,automaticRetryEnabled:false,automaticRollbackEnabled:false}),
  });
}
