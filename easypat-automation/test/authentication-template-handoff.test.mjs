import test from "node:test";
import assert from "node:assert/strict";
import {createCipheriv,createDecipheriv,randomBytes} from "node:crypto";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {readFileSync} from "node:fs";
import {AUTHENTICATION_BATCH_SHAPES} from "../src/protocol/authentication-batch-binding.mjs";
import {createCredentialFreeAuthenticationTemplate} from "../src/security/authentication-template-store.mjs";
import {fingerprintEnvelope} from "../src/protocol/template-fingerprint.mjs";
import {createAuthenticationHandoffKey,exportAuthenticationTemplateHandoff,importAuthenticationTemplateHandoff} from "../src/security/authentication-template-handoff.mjs";

const loginShape=JSON.parse(readFileSync(new URL("../config/protocol-observations/authentication-request-shape.json",import.meta.url))).shape;
function template(){const values=[[10,120,"'N'"],[1,"'fixture'","'N'","'N'","'Y'","'fixture'","'secret'"],[...Array.from({length:5},()=>["'Y'","'Y'","''"]).flat(),"'fixture'"],[],[108]];const sql=AUTHENTICATION_BATCH_SHAPES.map((shape,index)=>{let n=0;return(shape??loginShape).replaceAll("<value>",()=>String(values[index][n++]));});return createCredentialFreeAuthenticationTemplate(new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"5",command:"OTHERS",...Object.fromEntries(sql.map((value,index)=>["sql"+index,value]))}).toString());}
function protection(){const key=randomBytes(32);return{async protect(bytes){const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv);return Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);},async unprotect(bytes){const decipher=createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(-16));return Buffer.concat([decipher.update(bytes.subarray(12,-16)),decipher.final()]);}};}

test("moves only a credential-free authentication template between user protections",async()=>{
  const parent=await mkdtemp(path.join(tmpdir(),"easypat-handoff-")),root=path.join(parent,"handoff"),source=template(),fingerprint=fingerprintEnvelope(source),userProtection=protection();let saved;
  try{
    await createAuthenticationHandoffKey({root,protection:userProtection});
    await exportAuthenticationTemplateHandoff({root,sourceStore:{load:async()=>source},expectedFingerprint:fingerprint});
    const bundle=await readFile(path.join(root,"template-bundle.json"));assert.ok(!bundle.includes(Buffer.from("__EASYPAT_USERNAME__")));
    const result=await importAuthenticationTemplateHandoff({root,expectedFingerprint:fingerprint,protection:userProtection,targetStore:{save:async value=>{saved=structuredClone(value);},load:async()=>saved}});
    assert.equal(result.fingerprintVerified,true);assert.equal(result.handoffArtifactsRemoved,true);assert.deepEqual(saved,source);
  }finally{await rm(parent,{recursive:true,force:true});}
});

test("wrong user protection cannot import or expose the template",async()=>{
  const parent=await mkdtemp(path.join(tmpdir(),"easypat-handoff-")),root=path.join(parent,"handoff"),source=template(),fingerprint=fingerprintEnvelope(source);let saves=0;
  try{
    await createAuthenticationHandoffKey({root,protection:protection()});
    await exportAuthenticationTemplateHandoff({root,sourceStore:{load:async()=>source},expectedFingerprint:fingerprint});
    await assert.rejects(importAuthenticationTemplateHandoff({root,expectedFingerprint:fingerprint,protection:protection(),targetStore:{save:async()=>{saves++;},load:async()=>source}}),e=>e.message==="AUTH_HANDOFF_IMPORT_FAILED"&&!String(e).includes("fixture"));
    assert.equal(saves,0);
  }finally{await rm(parent,{recursive:true,force:true});}
});
