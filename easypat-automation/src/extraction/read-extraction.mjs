import {createHash} from "node:crypto";
import {lstat,readFile,realpath} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const artifactPath=fileURLToPath(new URL("../../.local/extractions/P261793/P261545외_수임내역서(수정).ocr.v3.json",import.meta.url));
const sourcePath=fileURLToPath(new URL("../../.local/downloads/P261793/P261545외_수임내역서(수정).jpg",import.meta.url));
const sourceSha256="74fe072fb2ac8e0ac0e989370a82ef7770f00eccaffa4a9df2f43cf47817c778";

const safeStrings=(value,maximumCount,maximumLength)=>Array.isArray(value)&&value.length<=maximumCount&&value.every(item=>typeof item==="string"&&item.length<=maximumLength&&!/[\p{Cc}\p{Cs}]/u.test(item));

export async function readP261793Extraction(){
  for(const candidate of [artifactPath,sourcePath]){const info=await lstat(candidate);if(!info.isFile()||info.isSymbolicLink()||path.resolve(await realpath(candidate)).toLowerCase()!==path.resolve(candidate).toLowerCase())throw new Error("EXTRACTION_ARTIFACT_REJECTED");}
  const sourceBytes=await readFile(sourcePath);try{if(sourceBytes.length!==51373||createHash("sha256").update(sourceBytes).digest("hex")!==sourceSha256)throw new Error("EXTRACTION_SOURCE_REJECTED");}finally{sourceBytes.fill(0);}
  const artifact=JSON.parse(await readFile(artifactPath,"utf8"));
  const facts=artifact?.facts;
  if(artifact?.schemaVersion!==3||artifact?.matterContext!=="P261793"||artifact?.sourceFileName!=="P261545외_수임내역서(수정).jpg"||artifact?.sourceBinding!=="validated-p261793-shared-document-group-position-2"||artifact?.ocr?.engine!=="windows-media-ocr"||artifact?.ocr?.language!=="ko-KR"||!Number.isInteger(facts?.lineCount)||facts.lineCount<0||facts.lineCount>1000||!Number.isInteger(facts?.maskedTokenCount)||facts.maskedTokenCount<0||!safeStrings(facts?.matterReferences,100,64)||!safeStrings(facts?.amountExpressions,100,64)||!safeStrings(facts?.keywordHits,100,64))throw new Error("EXTRACTION_ARTIFACT_REJECTED");
  return Object.freeze({matterContext:"P261793",sourceFileName:artifact.sourceFileName,ocrEngine:artifact.ocr.engine,ocrLanguage:artifact.ocr.language,lineCount:facts.lineCount,matterReferences:Object.freeze([...facts.matterReferences]),amountExpressions:Object.freeze([...facts.amountExpressions]),keywordHits:Object.freeze([...facts.keywordHits]),maskedTokenCount:facts.maskedTokenCount,rawOcrTextReturned:false,externalUploadPerformed:false});
}
