import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {lstat,readdir,realpath} from "node:fs/promises";
import path from "node:path";

const execFileAsync=promisify(execFile);

async function findFfmpeg(){
  const localAppData=process.env.LOCALAPPDATA;
  if(typeof localAppData!=="string"||!path.isAbsolute(localAppData))throw new Error("FFMPEG_NOT_FOUND");
  const packagesRoot=path.resolve(localAppData,"Microsoft","WinGet","Packages");
  const packageNames=(await readdir(packagesRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith("Gyan.FFmpeg_Microsoft.Winget.Source_")).map(entry=>entry.name).sort().reverse();
  for(const packageName of packageNames){
    const packageRoot=path.join(packagesRoot,packageName);
    const builds=(await readdir(packageRoot,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&entry.name.startsWith("ffmpeg-")).map(entry=>entry.name).sort().reverse();
    for(const build of builds){
      const candidate=path.join(packageRoot,build,"bin","ffmpeg.exe");
      try{const info=await lstat(candidate),resolved=path.resolve(await realpath(candidate));if(info.isFile()&&!info.isSymbolicLink()&&resolved.toLowerCase()===path.resolve(candidate).toLowerCase()&&resolved.toLowerCase().startsWith(packagesRoot.toLowerCase()+path.sep))return resolved;}catch{}
    }
  }
  throw new Error("FFMPEG_NOT_FOUND");
}

export async function preprocessForOcr(source,destination,{runner=execFileAsync}={}){
  const sourcePath=path.resolve(source),destinationPath=path.resolve(destination);
  const sourceInfo=await lstat(sourcePath);
  if(!sourceInfo.isFile()||sourceInfo.isSymbolicLink()||sourceInfo.size!==51373||path.resolve(await realpath(sourcePath)).toLowerCase()!==sourcePath.toLowerCase())throw new Error("OCR_SOURCE_REJECTED");
  if(path.extname(destinationPath).toLowerCase()!==".png"||path.dirname(destinationPath)===path.dirname(sourcePath))throw new Error("OCR_PREPROCESS_PATH_REJECTED");
  const ffmpeg=await findFfmpeg();
  await runner(ffmpeg,["-nostdin","-hide_banner","-loglevel","error","-n","-i",sourcePath,"-vf","scale=iw*4:ih*4:flags=lanczos,format=gray,eq=contrast=1.25:brightness=0.03,unsharp=5:5:1.0","-frames:v","1",destinationPath],{windowsHide:true,timeout:30000,maxBuffer:1024*1024});
  const outputInfo=await lstat(destinationPath);
  if(!outputInfo.isFile()||outputInfo.isSymbolicLink()||outputInfo.size<1||outputInfo.size>10*1024*1024||path.resolve(await realpath(destinationPath)).toLowerCase()!==destinationPath.toLowerCase())throw new Error("OCR_PREPROCESS_OUTPUT_REJECTED");
  return destinationPath;
}
