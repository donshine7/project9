import {constants as fsConstants} from "node:fs";
import {access,lstat,realpath} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {generateKeyPairSync} from "node:crypto";
import {windowsProtection} from "./security/windows-secrets.mjs";

const parent=path.resolve(fileURLToPath(new URL("../.local/",import.meta.url)));
const target=path.join(parent,"read-template-handoff");
let stage="platform",plain,protectedBytes,restored;
const result={platformWindows:process.platform==="win32",parentSafe:false,parentWritable:false,targetAbsent:false,rsaGeneration:false,dpapiRoundTrip:false,secretValuesReturned:false};
try{
  if(!result.platformWindows)throw new Error();
  stage="parent-path";
  const info=await lstat(parent);
  if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(parent)).toLowerCase()!==parent.toLowerCase())throw new Error();
  result.parentSafe=true;
  stage="parent-write-access";await access(parent,fsConstants.W_OK);result.parentWritable=true;
  stage="target-absence";
  try{await lstat(target);throw new Error();}catch(error){if(error?.code!=="ENOENT")throw error;}
  result.targetAbsent=true;
  stage="rsa-generation";
  const pair=generateKeyPairSync("rsa",{modulusLength:3072,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
  if(typeof pair.publicKey!=="string"||typeof pair.privateKey!=="string")throw new Error();
  result.rsaGeneration=true;
  stage="dpapi-round-trip";plain=Buffer.from("easypat-handoff-diagnostic","utf8");protectedBytes=await windowsProtection.protect(plain);restored=await windowsProtection.unprotect(protectedBytes);
  if(!Buffer.isBuffer(restored)||!restored.equals(plain))throw new Error();
  result.dpapiRoundTrip=true;
  console.log(JSON.stringify({status:"read-handoff-key-preflight-ready",...result}));
}catch{
  console.error(JSON.stringify({status:"read-handoff-key-preflight-failed",failureStage:stage,...result}));process.exitCode=1;
}finally{plain?.fill(0);protectedBytes?.fill(0);restored?.fill(0);}
