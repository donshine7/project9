import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintEnvelope } from "../protocol/template-fingerprint.mjs";
import { windowsProtection } from "./windows-secrets.mjs";

const defaultRoot=fileURLToPath(new URL("../../.local/templates-user/",import.meta.url));
export function createTemplateStore({candidates,root=defaultRoot,protection=windowsProtection}){
  const known=structuredClone(candidates);
  const resolvedRoot=path.resolve(root);
  function candidateFor(id){
    const c=known.find(c=>c.templateId===id);
    if(!c||!/^[a-z0-9.-]+$/.test(id))throw new Error("UNKNOWN_TEMPLATE");
    return c;
  }
  function validate(id,payload){
    const candidate=candidateFor(id);
    if(!payload||Object.keys(payload).sort().join(",")!=="command,statements,templateId"||payload.templateId!==id||payload.command!==candidate.command||payload.statements?.length!==candidate.statementCount||fingerprintEnvelope(payload)!==candidate.fingerprint)throw new Error("TEMPLATE_CONTENT_REJECTED");
  }
  async function filename(id){
    candidateFor(id);
    await mkdir(resolvedRoot,{recursive:true});
    if((await lstat(resolvedRoot)).isSymbolicLink()||path.resolve(await realpath(resolvedRoot)).toLowerCase()!==resolvedRoot.toLowerCase())throw new Error("UNSAFE_STORE_PATH");
    return path.join(resolvedRoot,id+".dpapi");
  }
  return Object.freeze({
    async save(id,envelope){
      let plain;
      try{
        validate(id,envelope);
        const target=await filename(id);
        plain=Buffer.from(JSON.stringify(envelope),"utf8");
        const encrypted=await protection.protect(plain);
        if(!Buffer.isBuffer(encrypted)||!encrypted.length||encrypted.length>2*1024*1024)throw new Error();
        await writeFile(target,encrypted,{flag:"wx",mode:0o600});
        return {templateId:id,stored:true,protection:"Windows-DPAPI-CurrentUser",liveEnabled:false};
      }catch{throw new Error("TEMPLATE_STORE_SAVE_FAILED");}finally{plain?.fill(0);}
    },
    async load(id){
      let plain;
      try{
        const target=await filename(id),info=await lstat(target);
        if(!info.isFile()||info.isSymbolicLink()||info.size>2*1024*1024)throw new Error();
        plain=await protection.unprotect(await readFile(target));
        if(!Buffer.isBuffer(plain)||plain.length>1024*1024)throw new Error();
        const envelope=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));
        validate(id,envelope);return envelope;
      }catch{throw new Error("TEMPLATE_STORE_LOAD_FAILED");}finally{plain?.fill(0);}
    },
  });
}
