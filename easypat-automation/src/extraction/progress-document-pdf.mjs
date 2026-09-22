import {execFile} from "node:child_process";
import {lstat,realpath} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {normalizeExactMatterReference} from "../protocol/matter-reference.mjs";

const run=promisify(execFile),downloadRoot=path.resolve(fileURLToPath(new URL("../../.local/downloads/",import.meta.url))),script=fileURLToPath(new URL("../../scripts/extract_easy_pat_intake_pdf.py",import.meta.url));
const expectedKeys=["applicant","applicationType","assignee","databaseManager","estimateAndPowerOfAttorney","fee","introducer","inventorInstruction","note","practitioner"];

function safeInput({matterReference,fileName}={}){
  const matter=normalizeExactMatterReference(matterReference);
  if(typeof fileName!=="string"||!fileName.toLowerCase().endsWith(".pdf")||fileName.length>260||/[\p{Cc}\p{Cs}\\/:*?"<>|]/u.test(fileName))throw new Error("PDF_EXTRACTION_INPUT_REJECTED");
  return{matterReference:matter,fileName};
}

function validate(result,matterReference,fileName){
  if(!result||result.sourceFileName!==fileName||!/^[a-f0-9]{64}$/.test(result.sourceSha256)||!Number.isSafeInteger(result.pageCount)||result.pageCount<1||result.pageCount>50||
     !result.fields||Object.keys(result.fields).sort().join(",")!==expectedKeys.join(",")||Object.values(result.fields).some(value=>value!==null&&(typeof value!=="string"||value.length>512||/[\p{Cc}\p{Cs}]/u.test(value)))||
     (result.requestedMatterCount!==null&&(!Number.isSafeInteger(result.requestedMatterCount)||result.requestedMatterCount<1||result.requestedMatterCount>999))||
     (result.requestedMatterPrefix!==null&&!/^(PPT|PT|P|T|D)$/.test(result.requestedMatterPrefix))||!Array.isArray(result.relatedMatterReferences)||result.relatedMatterReferences.length>100||
     result.relatedMatterReferences.some(reference=>{try{return normalizeExactMatterReference(reference)!==reference;}catch{return true;}})||new Set(result.relatedMatterReferences).size!==result.relatedMatterReferences.length||
     result.rawTextReturned!==false||result.emailAddressesReturned!==false||result.contactDetailsReturned!==false||result.externalUploadPerformed!==false)throw new Error("PDF_EXTRACTION_REJECTED");
  return Object.freeze({matterReference,...result,fields:Object.freeze({...result.fields}),relatedMatterReferences:Object.freeze([...result.relatedMatterReferences])});
}

export async function extractProgressDocumentPdf(input){
  const {matterReference,fileName}=safeInput(input),matterRoot=path.resolve(downloadRoot,matterReference),source=path.resolve(matterRoot,fileName);
  if(path.dirname(source).toLowerCase()!==matterRoot.toLowerCase())throw new Error("PDF_EXTRACTION_INPUT_REJECTED");
  const [rootInfo,sourceInfo]=await Promise.all([lstat(matterRoot),lstat(source)]);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||path.resolve(await realpath(matterRoot)).toLowerCase()!==matterRoot.toLowerCase()||!sourceInfo.isFile()||sourceInfo.isSymbolicLink()||sourceInfo.size<5||sourceInfo.size>64*1024*1024||path.resolve(await realpath(source)).toLowerCase()!==source.toLowerCase())throw new Error("PDF_EXTRACTION_LOCAL_FILE_REJECTED");
  const python=path.join(os.homedir(),".cache","codex-runtimes","codex-primary-runtime","dependencies","python","python.exe");
  const {stdout}=await run(python,["-X","utf8",script,source],{encoding:"utf8",windowsHide:true,maxBuffer:1024*1024,timeout:30_000,env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"}});
  let parsed;try{parsed=JSON.parse(stdout);}catch{throw new Error("PDF_EXTRACTION_REJECTED");}
  return validate(parsed,matterReference,fileName);
}
