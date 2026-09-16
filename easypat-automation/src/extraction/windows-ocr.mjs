import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {lstat,realpath} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

const execFileAsync=promisify(execFile);
const allowedRoot=path.resolve(fileURLToPath(new URL("../../.local/downloads/P261793/",import.meta.url)));
const allowedExtractionRoot=path.resolve(fileURLToPath(new URL("../../.local/extractions/P261793/",import.meta.url)));
const scriptPath=fileURLToPath(new URL("../../scripts/Invoke-WindowsOcr.ps1",import.meta.url));

export async function recognizeDownloadedImage(filePath,{runner=execFileAsync}={}){
  const resolved=path.resolve(filePath);
  const original=path.dirname(resolved).toLowerCase()===allowedRoot.toLowerCase()&&path.basename(resolved)==="P261545외_수임내역서(수정).jpg";
  const preprocessed=path.dirname(resolved).toLowerCase()===allowedExtractionRoot.toLowerCase()&&path.basename(resolved)==="P261545외_수임내역서(수정).preprocessed.v3.png";
  if(!original&&!preprocessed)throw new Error("OCR_PATH_REJECTED");
  const info=await lstat(resolved);
  if(!info.isFile()||info.isSymbolicLink()||path.resolve(await realpath(resolved)).toLowerCase()!==resolved.toLowerCase()||(original?info.size!==51373:info.size<1||info.size>10*1024*1024))throw new Error("OCR_FILE_REJECTED");
  const {stdout}=await runner("powershell.exe",["-NoLogo","-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath,"-LiteralPath",resolved,"-Language","ko-KR"],{windowsHide:true,timeout:30000,maxBuffer:1024*1024,encoding:"utf8"});
  const parsed=JSON.parse(stdout.trim());
  if(parsed?.engine!=="windows-media-ocr"||parsed?.language!=="ko-KR"||typeof parsed?.text!=="string"||!Array.isArray(parsed?.lines)||parsed.text.length>100000)throw new Error("OCR_RESPONSE_REJECTED");
  return parsed;
}
