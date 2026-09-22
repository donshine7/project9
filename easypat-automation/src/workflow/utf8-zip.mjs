import {randomUUID} from "node:crypto";
import {readFile,unlink,writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";

const createScript=fileURLToPath(new URL("../../scripts/New-Utf8Zip.ps1",import.meta.url));
const defaultPowerShell=process.env.EASYPAT_PWSH_PATH||"pwsh.exe";

function run(command,args){return new Promise((resolve,reject)=>{const child=spawn(command,args,{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]}),err=[];let size=0;child.stderr.on("data",chunk=>{if(size<32768){const bytes=Buffer.from(chunk);err.push(bytes);size+=bytes.length;}});child.on("error",()=>reject(new Error("UTF8_ZIP_COMMAND_FAILED")));child.on("close",code=>code===0?resolve():reject(new Error("UTF8_ZIP_COMMAND_FAILED")));});}
function eocd(bytes){for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(bytes.readUInt32LE(offset)===0x06054b50)return offset;throw new Error("UTF8_ZIP_STRUCTURE_REJECTED");}

export function inspectUtf8ZipBytes(bytes,{expectedEntries}={}){
  if(!Buffer.isBuffer(bytes)||bytes.length<22||!Array.isArray(expectedEntries)||expectedEntries.length<1||expectedEntries.length>501)throw new Error("UTF8_ZIP_STRUCTURE_REJECTED");
  const end=eocd(bytes),disk=bytes.readUInt16LE(end+4),centralDisk=bytes.readUInt16LE(end+6),diskEntries=bytes.readUInt16LE(end+8),count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),centralOffset=bytes.readUInt32LE(end+16);
  if(disk!==0||centralDisk!==0||diskEntries!==count||count!==expectedEntries.length||count===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff||centralOffset+centralSize>end)throw new Error("UTF8_ZIP_STRUCTURE_REJECTED");
  const decoder=new TextDecoder("utf-8",{fatal:true}),names=[];let offset=centralOffset;
  for(let index=0;index<count;index++){
    if(offset+46>bytes.length||bytes.readUInt32LE(offset)!==0x02014b50)throw new Error("UTF8_ZIP_STRUCTURE_REJECTED");
    const flags=bytes.readUInt16LE(offset+8),nameLength=bytes.readUInt16LE(offset+28),extraLength=bytes.readUInt16LE(offset+30),commentLength=bytes.readUInt16LE(offset+32),nameBytes=bytes.subarray(offset+46,offset+46+nameLength);
    let name;try{name=decoder.decode(nameBytes);}catch{throw new Error("UTF8_ZIP_FILENAME_ENCODING_REJECTED");}
    if((flags&1)!==0||/[^\x00-\x7f]/u.test(name)&&(flags&0x800)===0||name.startsWith("/")||name.includes("\\")||/(^|\/)\.\.($|\/)/u.test(name))throw new Error("UTF8_ZIP_FILENAME_ENCODING_REJECTED");
    names.push(name);offset+=46+nameLength+extraLength+commentLength;
  }
  if(offset!==centralOffset+centralSize||JSON.stringify(names.slice().sort())!==JSON.stringify(expectedEntries.slice().sort()))throw new Error("UTF8_ZIP_ENTRY_LIST_REJECTED");
  return Object.freeze({entryCount:names.length,entries:Object.freeze(names),utf8FileNamesVerified:true,encryptedEntriesPresent:false});
}

export async function createUtf8ZipArchive({sourceRoot,outputPath,entries,powerShell=defaultPowerShell}={}){
  if(typeof sourceRoot!=="string"||typeof outputPath!=="string"||!Array.isArray(entries)||entries.length<1||entries.length>501||entries.some(entry=>typeof entry!=="string"||!entry.length))throw new Error("UTF8_ZIP_INPUT_REJECTED");
  const entryListPath=path.join(path.dirname(outputPath),`.zip-entries-${randomUUID()}.json`);
  try{
    await writeFile(entryListPath,JSON.stringify(entries),{encoding:"utf8",mode:0o600,flag:"wx"});
    await run(powerShell,["-NoLogo","-NoProfile","-File",createScript,"-SourceRoot",sourceRoot,"-OutputPath",outputPath,"-EntryListPath",entryListPath]);
    const bytes=await readFile(outputPath),inspection=inspectUtf8ZipBytes(bytes,{expectedEntries:entries});return Object.freeze({fileSizeBytes:bytes.length,...inspection});
  }finally{try{await unlink(entryListPath);}catch{}}
}
