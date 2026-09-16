import {constants as cryptoConstants,createCipheriv,createDecipheriv,createPrivateKey,createPublicKey,privateDecrypt,publicEncrypt,randomBytes} from "node:crypto";
import {lstat,readFile,realpath,rmdir,unlink,writeFile} from "node:fs/promises";
import path from "node:path";
import {fingerprintEnvelope} from "../protocol/template-fingerprint.mjs";

const PUBLIC_FILE="public-key.pem",PRIVATE_FILE="private-key.dpapi",BUNDLE_FILE="read-template-bundle.json";
async function rootPath(root){const resolved=path.resolve(root),info=await lstat(resolved);if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(resolved)).toLowerCase()!==resolved.toLowerCase())throw new Error();return resolved;}
async function bounded(file,max){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>max)throw new Error();return readFile(file);}
function decode(value,max){if(typeof value!=="string"||!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||value.length>Math.ceil(max/3)*4)throw new Error();const bytes=Buffer.from(value,"base64");if(bytes.length>max||bytes.toString("base64")!==value)throw new Error();return bytes;}
function validateTemplates(templates,candidates,templateIds){
  if(!Array.isArray(templates)||templates.length!==templateIds.length)throw new Error();
  return templateIds.map(id=>{const template=templates.find(item=>item?.templateId===id),candidate=candidates.find(item=>item.templateId===id);if(!template||!candidate||template.command!==candidate.command||template.statements?.length!==candidate.statementCount||fingerprintEnvelope(template)!==candidate.fingerprint)throw new Error();return template;});
}

export async function exportReadTemplateHandoff({root,sourceStore,candidates,templateIds}={}){
  let plain,key,iv,tag,ciphertext,wrappedKey,publicBytes;
  try{
    if(!sourceStore||!Array.isArray(candidates)||!Array.isArray(templateIds)||new Set(templateIds).size!==templateIds.length)throw new Error();
    const resolved=await rootPath(root),templates=validateTemplates(await Promise.all(templateIds.map(id=>sourceStore.load(id))),candidates,templateIds);
    publicBytes=await bounded(path.join(resolved,PUBLIC_FILE),16*1024);const publicKey=createPublicKey(publicBytes);if(publicKey.asymmetricKeyType!=="rsa")throw new Error();
    plain=Buffer.from(JSON.stringify({schemaVersion:1,kind:"read-templates",templates}),"utf8");key=randomBytes(32);iv=randomBytes(12);const cipher=createCipheriv("aes-256-gcm",key,iv);ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);tag=cipher.getAuthTag();wrappedKey=publicEncrypt({key:publicKey,padding:cryptoConstants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key);
    const bundle={schemaVersion:1,algorithm:"RSA-OAEP-SHA256+A256GCM",kind:"read-templates",templateCount:templates.length,wrappedKey:wrappedKey.toString("base64"),iv:iv.toString("base64"),tag:tag.toString("base64"),ciphertext:ciphertext.toString("base64")};
    await writeFile(path.join(resolved,BUNDLE_FILE),Buffer.from(JSON.stringify(bundle),"utf8"),{flag:"wx",mode:0o600});return{status:"read-templates-encrypted-for-user",templateCount:templates.length,fingerprintsVerified:true,plaintextTemplatesWritten:false};
  }catch{throw new Error("READ_TEMPLATE_HANDOFF_EXPORT_FAILED");}finally{for(const item of[plain,key,iv,tag,ciphertext,wrappedKey,publicBytes])item?.fill(0);}
}

export async function importReadTemplateHandoff({root,targetStore,candidates,templateIds,protection}={}){
  let protectedPrivate,privateBytes,bundleBytes,wrappedKey,iv,tag,ciphertext,key,plain;
  try{
    if(!targetStore||!protection||typeof protection.unprotect!=="function")throw new Error();const resolved=await rootPath(root);
    protectedPrivate=await bounded(path.join(resolved,PRIVATE_FILE),64*1024);privateBytes=await protection.unprotect(protectedPrivate);const privateKey=createPrivateKey(privateBytes);if(privateKey.asymmetricKeyType!=="rsa")throw new Error();
    bundleBytes=await bounded(path.join(resolved,BUNDLE_FILE),2*1024*1024);const bundle=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bundleBytes));if(!bundle||Object.keys(bundle).sort().join(",")!=="algorithm,ciphertext,iv,kind,schemaVersion,tag,templateCount,wrappedKey"||bundle.schemaVersion!==1||bundle.algorithm!=="RSA-OAEP-SHA256+A256GCM"||bundle.kind!=="read-templates"||bundle.templateCount!==templateIds.length)throw new Error();
    wrappedKey=decode(bundle.wrappedKey,512);iv=decode(bundle.iv,12);tag=decode(bundle.tag,16);ciphertext=decode(bundle.ciphertext,1024*1024);if(iv.length!==12||tag.length!==16)throw new Error();key=privateDecrypt({key:privateKey,padding:cryptoConstants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},wrappedKey);if(key.length!==32)throw new Error();const decipher=createDecipheriv("aes-256-gcm",key,iv);decipher.setAuthTag(tag);plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    const payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));if(!payload||Object.keys(payload).sort().join(",")!=="kind,schemaVersion,templates"||payload.schemaVersion!==1||payload.kind!=="read-templates")throw new Error();const templates=validateTemplates(payload.templates,candidates,templateIds);
    for(const template of templates)await targetStore.save(template.templateId,template);for(const template of templates)await targetStore.load(template.templateId);
    let removed=true;for(const name of[PUBLIC_FILE,PRIVATE_FILE,BUNDLE_FILE]){try{await unlink(path.join(resolved,name));}catch{removed=false;}}if(removed){try{await rmdir(resolved);}catch{removed=false;}}
    return{status:"read-templates-imported",templateCount:templates.length,fingerprintsVerified:true,protection:"Windows-DPAPI-CurrentUser",handoffArtifactsRemoved:removed,liveEnabled:false};
  }catch{throw new Error("READ_TEMPLATE_HANDOFF_IMPORT_FAILED");}finally{for(const item of[protectedPrivate,privateBytes,bundleBytes,wrappedKey,iv,tag,ciphertext,key,plain])item?.fill(0);}
}
