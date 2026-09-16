import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {recognizeDownloadedImage} from "./extraction/windows-ocr.mjs";
import {preprocessForOcr} from "./extraction/image-preprocess.mjs";
import {extractTextFacts} from "./extraction/text-facts.mjs";

const inputPath=fileURLToPath(new URL("../.local/downloads/P261793/P261545외_수임내역서(수정).jpg",import.meta.url));
const outputRoot=path.resolve(fileURLToPath(new URL("../.local/extractions/P261793/",import.meta.url)));
const preprocessedPath=path.join(outputRoot,"P261545외_수임내역서(수정).preprocessed.v3.png");
const outputPath=path.join(outputRoot,"P261545외_수임내역서(수정).ocr.v3.json");

try{
  await mkdir(outputRoot,{recursive:true});
  const rootInfo=await lstat(outputRoot);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||path.resolve(await realpath(outputRoot)).toLowerCase()!==outputRoot.toLowerCase())throw new Error("EXTRACTION_PATH_REJECTED");
  await preprocessForOcr(inputPath,preprocessedPath);
  const ocr=await recognizeDownloadedImage(preprocessedPath);
  const facts=extractTextFacts(ocr.text);
  const artifact={schemaVersion:3,matterContext:"P261793",sourceFileName:"P261545외_수임내역서(수정).jpg",sourceBinding:"validated-p261793-shared-document-group-position-2",preprocessing:"4x-lanczos-grayscale-contrast-unsharp",extractedAt:new Date().toISOString(),ocr,facts};
  await writeFile(outputPath,JSON.stringify(artifact,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify({status:"local-image-extracted",matterContext:"P261793",sourceFileName:artifact.sourceFileName,ocrEngine:ocr.engine,ocrLanguage:ocr.language,lineCount:facts.lineCount,matterReferences:facts.matterReferences,amountExpressionCount:facts.amountExpressions.length,keywordHits:facts.keywordHits,maskedTokenCount:facts.maskedTokenCount,rawTextReturned:false,outputPath,overwritten:false,externalUploadPerformed:false}));
}catch(error){
  console.error(JSON.stringify({status:"local-image-extraction-failed",failureCode:error?.code==="EEXIST"?"LOCAL_EXTRACTION_EXISTS":"LOCAL_EXTRACTION_FAILED",rawTextReturned:false,externalUploadPerformed:false}));
  process.exitCode=1;
}
