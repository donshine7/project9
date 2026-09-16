import {mkdir,readFile,writeFile,lstat,realpath} from "node:fs/promises";
import path from "node:path";import {fileURLToPath} from "node:url";
import {fingerprintEnvelope} from "../protocol/template-fingerprint.mjs";
import {compileAuthenticationBatch} from "../protocol/authentication-batch-binding.mjs";
import {windowsProtection} from "./windows-secrets.mjs";
export const AUTH_TEMPLATE_ID="authentication.login-batch.v1";
const USER="__EASYPAT_USERNAME__",PASSWORD="__EASYPAT_PASSWORD__";
const defaultRoot=fileURLToPath(new URL("../../.local/authentication-user/",import.meta.url));
function envelopeFromBody(body){const f=new URLSearchParams(body);return {templateId:AUTH_TEMPLATE_ID,command:f.get("command"),statements:Array.from({length:5},(_,i)=>f.get("sql"+i))};}
export function createCredentialFreeAuthenticationTemplate(copied){
  try{const compiled=compileAuthenticationBatch(copied);const envelope=envelopeFromBody(compiled.bind({username:USER,password:PASSWORD}));validateShape(envelope);return envelope;}catch{throw new Error("AUTH_TEMPLATE_EXPORT_REJECTED");}
}
function validateShape(envelope){
  if(!envelope||Object.keys(envelope).sort().join(",")!=="command,statements,templateId"||envelope.templateId!==AUTH_TEMPLATE_ID||envelope.command!=="OTHERS"||envelope.statements?.length!==5)throw new Error();
  const body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"5",command:"OTHERS",...Object.fromEntries(envelope.statements.map((s,i)=>["sql"+i,s]))}).toString();
  compileAuthenticationBatch(body);
  const joined=envelope.statements.join("\n");
  if((joined.match(new RegExp(USER,"g"))||[]).length!==3||(joined.match(new RegExp(PASSWORD,"g"))||[]).length!==1)throw new Error();
}
export function compileStoredAuthenticationTemplate(envelope,expectedFingerprint){
  try{validateShape(envelope);if(!/^[a-f0-9]{64}$/.test(expectedFingerprint)||fingerprintEnvelope(envelope)!==expectedFingerprint)throw new Error();const body=new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"5",command:"OTHERS",...Object.fromEntries(envelope.statements.map((s,i)=>["sql"+i,s]))}).toString();return compileAuthenticationBatch(body);}catch{throw new Error("AUTH_STORED_TEMPLATE_REJECTED");}
}
export function createAuthenticationTemplateStore({expectedFingerprint,root=defaultRoot,protection=windowsProtection}={}){
  const resolved=path.resolve(root);const target=path.join(resolved,AUTH_TEMPLATE_ID+".dpapi");
  async function safeTarget(){await mkdir(resolved,{recursive:true});if((await lstat(resolved)).isSymbolicLink()||path.resolve(await realpath(resolved)).toLowerCase()!==resolved.toLowerCase())throw new Error();return target;}
  return Object.freeze({
    async save(envelope){let plain;try{compileStoredAuthenticationTemplate(envelope,expectedFingerprint);plain=Buffer.from(JSON.stringify(envelope),"utf8");const encrypted=await protection.protect(plain);if(!Buffer.isBuffer(encrypted)||!encrypted.length||encrypted.length>2*1024*1024)throw new Error();await writeFile(await safeTarget(),encrypted,{flag:"wx",mode:0o600});return {templateId:AUTH_TEMPLATE_ID,stored:true,credentialFree:true,protection:"Windows-DPAPI-CurrentUser",liveEnabled:false};}catch{throw new Error("AUTH_TEMPLATE_STORE_SAVE_FAILED");}finally{plain?.fill(0);}},
    async load(){let plain;try{const file=await safeTarget(),info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024)throw new Error();plain=await protection.unprotect(await readFile(file));if(!Buffer.isBuffer(plain)||plain.length>1024*1024)throw new Error();const envelope=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));compileStoredAuthenticationTemplate(envelope,expectedFingerprint);return envelope;}catch{throw new Error("AUTH_TEMPLATE_STORE_LOAD_FAILED");}finally{plain?.fill(0);}},
  });
}
