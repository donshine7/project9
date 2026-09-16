import {constants as cryptoConstants,createCipheriv,createDecipheriv,createPrivateKey,createPublicKey,generateKeyPairSync,privateDecrypt,publicEncrypt,randomBytes} from "node:crypto";
import {lstat,mkdir,readFile,realpath,rmdir,unlink,writeFile} from "node:fs/promises";
import path from "node:path";
import {compileStoredAuthenticationTemplate} from "./authentication-template-store.mjs";
import {fingerprintEnvelope} from "../protocol/template-fingerprint.mjs";

const PUBLIC_FILE="public-key.pem",PRIVATE_FILE="private-key.dpapi",BUNDLE_FILE="template-bundle.json";

async function exactDirectory(root,{create=false}={}){
  const resolved=path.resolve(root);
  if(create)await mkdir(resolved,{recursive:false,mode:0o700});
  const info=await lstat(resolved);
  if(!info.isDirectory()||info.isSymbolicLink()||path.resolve(await realpath(resolved)).toLowerCase()!==resolved.toLowerCase())throw new Error();
  return resolved;
}
async function boundedRead(file,limit){const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>limit)throw new Error();return readFile(file);}
function decode(value,max){if(typeof value!=="string"||value.length<4||value.length>Math.ceil(max/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error();const bytes=Buffer.from(value,"base64");if(bytes.length>max||bytes.toString("base64")!==value)throw new Error();return bytes;}

export async function createAuthenticationHandoffKey({root,protection}={}){
  let privateBytes,protectedPrivate,publicBytes,resolved;
  try{
    if(!protection||typeof protection.protect!=="function")throw new Error();
    resolved=await exactDirectory(root,{create:true});
    const pair=generateKeyPairSync("rsa",{modulusLength:3072,publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
    publicBytes=Buffer.from(pair.publicKey,"utf8");privateBytes=Buffer.from(pair.privateKey,"utf8");
    protectedPrivate=await protection.protect(privateBytes);
    await writeFile(path.join(resolved,PUBLIC_FILE),publicBytes,{flag:"wx",mode:0o600});
    await writeFile(path.join(resolved,PRIVATE_FILE),protectedPrivate,{flag:"wx",mode:0o600});
    return {status:"handoff-key-created",privateKeyProtection:"Windows-DPAPI-CurrentUser",plaintextTemplateWritten:false};
  }catch{
    if(resolved){await unlink(path.join(resolved,PUBLIC_FILE)).catch(()=>{});await unlink(path.join(resolved,PRIVATE_FILE)).catch(()=>{});await rmdir(resolved).catch(()=>{});}
    throw new Error("AUTH_HANDOFF_KEY_CREATION_FAILED");
  }finally{privateBytes?.fill(0);protectedPrivate?.fill(0);publicBytes?.fill(0);}
}

export async function exportAuthenticationTemplateHandoff({root,sourceStore,expectedFingerprint}={}){
  let plain,key,iv,ciphertext,wrappedKey,tag,publicBytes;
  try{
    const resolved=await exactDirectory(root),template=await sourceStore.load();
    compileStoredAuthenticationTemplate(template,expectedFingerprint);
    publicBytes=await boundedRead(path.join(resolved,PUBLIC_FILE),16*1024);
    const publicKey=createPublicKey(publicBytes);if(publicKey.asymmetricKeyType!=="rsa")throw new Error();
    plain=Buffer.from(JSON.stringify(template),"utf8");key=randomBytes(32);iv=randomBytes(12);
    const cipher=createCipheriv("aes-256-gcm",key,iv);ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);tag=cipher.getAuthTag();
    wrappedKey=publicEncrypt({key:publicKey,padding:cryptoConstants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key);
    const bundle={schemaVersion:1,algorithm:"RSA-OAEP-SHA256+A256GCM",templateId:template.templateId,fingerprint:expectedFingerprint,wrappedKey:wrappedKey.toString("base64"),iv:iv.toString("base64"),tag:tag.toString("base64"),ciphertext:ciphertext.toString("base64")};
    await writeFile(path.join(resolved,BUNDLE_FILE),Buffer.from(JSON.stringify(bundle),"utf8"),{flag:"wx",mode:0o600});
    return {status:"credential-free-template-encrypted-for-user",fingerprintVerified:fingerprintEnvelope(template)===expectedFingerprint,plaintextTemplateWritten:false,credentialValuesIncluded:false};
  }catch{throw new Error("AUTH_HANDOFF_EXPORT_FAILED");}
  finally{for(const value of[plain,key,iv,ciphertext,wrappedKey,tag,publicBytes])value?.fill(0);}
}

export async function importAuthenticationTemplateHandoff({root,targetStore,expectedFingerprint,protection}={}){
  let protectedPrivate,privateBytes,bundleBytes,wrappedKey,iv,tag,ciphertext,key,plain;
  try{
    if(!protection||typeof protection.unprotect!=="function")throw new Error();
    const resolved=await exactDirectory(root);
    protectedPrivate=await boundedRead(path.join(resolved,PRIVATE_FILE),64*1024);privateBytes=await protection.unprotect(protectedPrivate);
    const privateKey=createPrivateKey(privateBytes);if(privateKey.asymmetricKeyType!=="rsa")throw new Error();
    bundleBytes=await boundedRead(path.join(resolved,BUNDLE_FILE),2*1024*1024);const bundle=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bundleBytes));
    if(!bundle||Object.keys(bundle).sort().join(",")!=="algorithm,ciphertext,fingerprint,iv,schemaVersion,tag,templateId,wrappedKey"||bundle.schemaVersion!==1||bundle.algorithm!=="RSA-OAEP-SHA256+A256GCM"||bundle.fingerprint!==expectedFingerprint)throw new Error();
    wrappedKey=decode(bundle.wrappedKey,512);iv=decode(bundle.iv,12);tag=decode(bundle.tag,16);ciphertext=decode(bundle.ciphertext,1024*1024);
    if(iv.length!==12||tag.length!==16)throw new Error();
    key=privateDecrypt({key:privateKey,padding:cryptoConstants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},wrappedKey);if(key.length!==32)throw new Error();
    const decipher=createDecipheriv("aes-256-gcm",key,iv);decipher.setAuthTag(tag);plain=Buffer.concat([decipher.update(ciphertext),decipher.final()]);
    const template=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));compileStoredAuthenticationTemplate(template,expectedFingerprint);
    await targetStore.save(template);const loaded=await targetStore.load();if(fingerprintEnvelope(loaded)!==expectedFingerprint)throw new Error();
    let removed=true;for(const name of[PUBLIC_FILE,PRIVATE_FILE,BUNDLE_FILE]){try{await unlink(path.join(resolved,name));}catch{removed=false;}}
    if(removed){try{await rmdir(resolved);}catch{removed=false;}}
    return {status:"credential-free-template-imported",fingerprintVerified:true,protection:"Windows-DPAPI-CurrentUser",handoffArtifactsRemoved:removed,credentialValuesIncluded:false,liveEnabled:false};
  }catch{throw new Error("AUTH_HANDOFF_IMPORT_FAILED");}
  finally{for(const value of[protectedPrivate,privateBytes,bundleBytes,wrappedKey,iv,tag,ciphertext,key,plain])value?.fill(0);}
}
