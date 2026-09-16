import { normalizeExactMatterReference } from "./matter-reference.mjs";

const ALLOWED_EXTENSIONS=new Set(["zip","jpg","jpeg","png","pdf","hwp","hwpx","doc","docx","xls","xlsx","ppt","pptx","txt"]);
const UPLOAD_PATH=/^upload\/app_proc\/(\d{4})\/(\d{2})\/(\d{2})\/([A-Za-z0-9._-]+)$/;

function safeText(value,maximum=512){
  if(value===null||value==="")return null;
  if(typeof value!=="string"||value.length>maximum||/[\p{Cc}\p{Cs}]/u.test(value))throw new Error("DOCUMENT_LIST_VALUE_REJECTED");
  return value;
}

function validatedRows(result){
  if(result?.matterReference!=="P261793"||result.templateId!=="matter-detail.documents.v1"||!Array.isArray(result.columns)||!Array.isArray(result.rows)||result.rows.length<1||result.rows.length>500)throw new Error("DOCUMENT_LIST_SOURCE_REJECTED");
  for(const required of ["DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE"]){if(!result.columns.includes(required))throw new Error("DOCUMENT_LIST_SCHEMA_REJECTED");}
  return result.rows.map(row=>{
    const documentName=safeText(row.DOC_NAME),registeredAt=safeText(row.REG_DATE),fileName=safeText(row.FILE_NAME,260),uploadPath=safeText(row.FILE_NAME_UPLOAD,1024),sizeText=row.FILE_SIZE;
    if(!fileName||/[\\/:*?"<>|]/u.test(fileName)||!uploadPath||!UPLOAD_PATH.test(uploadPath)||typeof sizeText!=="string"||!/^\d+$/.test(sizeText))throw new Error("DOCUMENT_LIST_VALUE_REJECTED");
    const extension=fileName.includes(".")?fileName.slice(fileName.lastIndexOf(".")+1).toLowerCase():"";
    const uploadLeaf=uploadPath.slice(uploadPath.lastIndexOf("/")+1),uploadExtension=uploadLeaf.includes(".")?uploadLeaf.slice(uploadLeaf.lastIndexOf(".")+1).toLowerCase():"";
    const size=Number(sizeText);
    if(!ALLOWED_EXTENSIONS.has(extension)||extension!==uploadExtension||!Number.isSafeInteger(size)||size<0||size>64*1024*1024)throw new Error("DOCUMENT_LIST_VALUE_REJECTED");
    return{documentName,registeredAt,fileName,uploadPath,size};
  });
}

function validatedBoundRows(result,expectedMatterReference){
  let matterReference;
  try{matterReference=normalizeExactMatterReference(expectedMatterReference);}
  catch{throw new Error("DOCUMENT_LIST_SOURCE_REJECTED");}
  if(result?.matterReference!==matterReference||result.templateId!=="matter-detail.documents.v1"||
     !Array.isArray(result.columns)||!Array.isArray(result.rows)||result.rows.length<1||result.rows.length>500){
    throw new Error("DOCUMENT_LIST_SOURCE_REJECTED");
  }
  for(const required of ["DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE"]){if(!result.columns.includes(required))throw new Error("DOCUMENT_LIST_SCHEMA_REJECTED");}
  const rows=result.rows.map(row=>{
    const documentName=safeText(row.DOC_NAME),registeredAt=safeText(row.REG_DATE),fileName=safeText(row.FILE_NAME,260),uploadPath=safeText(row.FILE_NAME_UPLOAD,1024),sizeText=row.FILE_SIZE;
    if(!fileName||/[\\/:*?"<>|]/u.test(fileName)||!uploadPath||!UPLOAD_PATH.test(uploadPath)||typeof sizeText!=="string"||!/^\d+$/.test(sizeText))throw new Error("DOCUMENT_LIST_VALUE_REJECTED");
    const extension=fileName.includes(".")?fileName.slice(fileName.lastIndexOf(".")+1).toLowerCase():"";
    const uploadLeaf=uploadPath.slice(uploadPath.lastIndexOf("/")+1),uploadExtension=uploadLeaf.includes(".")?uploadLeaf.slice(uploadLeaf.lastIndexOf(".")+1).toLowerCase():"";
    const size=Number(sizeText);
    if(!ALLOWED_EXTENSIONS.has(extension)||extension!==uploadExtension||!Number.isSafeInteger(size)||size<0||size>64*1024*1024)throw new Error("DOCUMENT_LIST_VALUE_REJECTED");
    return{documentName,registeredAt,fileName,uploadPath,size};
  });
  return{matterReference,rows};
}

export function inspectDocumentListEvidence(result){
  return inspectDocumentListEvidenceWithContext(result);
}

export function inspectDocumentListEvidenceWithContext(result,{contextBinding}={}){
  const rows=validatedRows(result),matterFilenameEvidenceCount=rows.filter(row=>row.fileName.toUpperCase().includes("P261793")).length,contextBound=contextBinding==="captured-p261793-fixed-document-group";
  if(matterFilenameEvidenceCount<1&&!contextBound)throw new Error("DOCUMENT_LIST_MATTER_EVIDENCE_REJECTED");
  return Object.freeze({matterReference:"P261793",templateId:"matter-detail.documents.v1",rowCount:rows.length,columnCount:result.columns.length,uploadPathShapeMatched:true,supportedFileTypesOnly:true,matterFilenameEvidenceCount,matterBindingMode:matterFilenameEvidenceCount>0?"filename-reference":"captured-p261793-fixed-document-group",rawRowsReturned:false,uploadPathsReturned:false,internalIdentitiesReturned:false});
}

export function diagnoseDocumentListEvidence(result){
  if(result?.matterReference!=="P261793"||result.templateId!=="matter-detail.documents.v1"||!Array.isArray(result.columns)||!Array.isArray(result.rows)||result.rows.length<1||result.rows.length>500)throw new Error("DOCUMENT_LIST_SOURCE_REJECTED");
  const required=["DOC_NAME","REG_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE"],missingRequiredColumns=required.filter(column=>!result.columns.includes(column)).length;
  const counts={invalidFileName:0,invalidUploadPath:0,unsupportedFileType:0,extensionMismatch:0,invalidFileSize:0,overSizeLimit:0,matterFilenameEvidence:0};
  for(const row of result.rows){
    const fileName=row?.FILE_NAME,uploadPath=row?.FILE_NAME_UPLOAD,sizeText=row?.FILE_SIZE;
    const fileNameOk=typeof fileName==="string"&&fileName.length>0&&fileName.length<=260&&!/[\p{Cc}\p{Cs}\\/:*?"<>|]/u.test(fileName);if(!fileNameOk)counts.invalidFileName++;
    const pathOk=typeof uploadPath==="string"&&uploadPath.length>0&&uploadPath.length<=1024&&UPLOAD_PATH.test(uploadPath);if(!pathOk)counts.invalidUploadPath++;
    const extension=fileNameOk&&fileName.includes(".")?fileName.slice(fileName.lastIndexOf(".")+1).toLowerCase():"",uploadLeaf=pathOk?uploadPath.slice(uploadPath.lastIndexOf("/")+1):"",uploadExtension=uploadLeaf.includes(".")?uploadLeaf.slice(uploadLeaf.lastIndexOf(".")+1).toLowerCase():"";
    if(!ALLOWED_EXTENSIONS.has(extension))counts.unsupportedFileType++;
    if(fileNameOk&&pathOk&&extension!==uploadExtension)counts.extensionMismatch++;
    const size=typeof sizeText==="string"&&/^\d+$/.test(sizeText)?Number(sizeText):NaN;if(!Number.isSafeInteger(size)||size<0)counts.invalidFileSize++;else if(size>64*1024*1024)counts.overSizeLimit++;
    if(fileNameOk&&fileName.toUpperCase().includes("P261793"))counts.matterFilenameEvidence++;
  }
  return Object.freeze({matterReference:"P261793",templateId:"matter-detail.documents.v1",rowCount:result.rows.length,columnCount:result.columns.length,missingRequiredColumns,...counts,rawRowsReturned:false,fileNamesReturned:false,uploadPathsReturned:false,valuesReturned:false});
}

export function projectDocumentList(result,{contextBinding}={}){
  const rows=validatedRows(result),matterFilenameEvidenceCount=rows.filter(row=>row.fileName.toUpperCase().includes("P261793")).length;
  if(matterFilenameEvidenceCount<1&&contextBinding!=="captured-p261793-fixed-document-group")throw new Error("DOCUMENT_LIST_MATTER_EVIDENCE_REJECTED");
  const items=rows.map((row,index)=>Object.freeze({position:index+1,documentName:row.documentName,registeredAt:row.registeredAt,fileName:row.fileName,fileSizeBytes:row.size}));
  return Object.freeze({matterReference:"P261793",count:items.length,items:Object.freeze(items)});
}

export function resolveDocumentDownload(result,{position,expectedFileName},{contextBinding}={}){
  const rows=validatedRows(result),matterFilenameEvidenceCount=rows.filter(row=>row.fileName.toUpperCase().includes("P261793")).length;
  if(matterFilenameEvidenceCount<1&&contextBinding!=="captured-p261793-fixed-document-group"||!Number.isInteger(position)||position<1||position>rows.length||typeof expectedFileName!=="string"||expectedFileName.length>260)throw new Error("DOCUMENT_DOWNLOAD_SELECTION_REJECTED");
  const selected=rows[position-1];if(selected.fileName!==expectedFileName)throw new Error("DOCUMENT_DOWNLOAD_SELECTION_REJECTED");
  return Object.freeze({position,fileName:selected.fileName,uploadPath:selected.uploadPath,fileSizeBytes:selected.size,extension:selected.fileName.slice(selected.fileName.lastIndexOf(".")+1).toLowerCase()});
}

export function projectVerifiedDocumentList(result,{matterReference,responseBindingVerified}={}){
  if(responseBindingVerified!==true)throw new Error("DOCUMENT_LIST_MATTER_EVIDENCE_REJECTED");
  const verified=validatedBoundRows(result,matterReference);
  const items=verified.rows.map((row,index)=>Object.freeze({position:index+1,documentName:row.documentName,registeredAt:row.registeredAt,fileName:row.fileName,fileSizeBytes:row.size}));
  return Object.freeze({matterReference:verified.matterReference,count:items.length,items:Object.freeze(items)});
}

// This result is for the trusted downloader only. MCP tools must expose the
// projected list above and must never return uploadPath.
export function resolveVerifiedDocumentDownload(result,{matterReference,position,expectedFileName,responseBindingVerified}={}){
  if(responseBindingVerified!==true||!Number.isInteger(position)||position<1||typeof expectedFileName!=="string"||expectedFileName.length>260){
    throw new Error("DOCUMENT_DOWNLOAD_SELECTION_REJECTED");
  }
  const verified=validatedBoundRows(result,matterReference);
  if(position>verified.rows.length)throw new Error("DOCUMENT_DOWNLOAD_SELECTION_REJECTED");
  const selected=verified.rows[position-1];
  if(selected.fileName!==expectedFileName)throw new Error("DOCUMENT_DOWNLOAD_SELECTION_REJECTED");
  return Object.freeze({matterReference:verified.matterReference,position,fileName:selected.fileName,uploadPath:selected.uploadPath,fileSizeBytes:selected.size,extension:selected.fileName.slice(selected.fileName.lastIndexOf(".")+1).toLowerCase()});
}
