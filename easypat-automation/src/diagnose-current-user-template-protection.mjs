import {readFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {fingerprintEnvelope} from "./protocol/template-fingerprint.mjs";
import {windowsProtection} from "./security/windows-secrets.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates;
const result={syntheticRoundTrip:false,main:{fileReady:false,dpapiReady:false,jsonReady:false,fingerprintReady:false},document:{fileReady:false,dpapiReady:false,jsonReady:false,fingerprintReady:false},intermediate:{fileReady:false,dpapiReady:false,jsonReady:false,fingerprintReady:false},rawValuesReturned:false,serverRequestsPerformed:0};
let synthetic=null,protectedSynthetic=null,restored=null;
async function inspect(target,id,fingerprint){
  let plain=null;
  try{
    const bytes=await readFile(path.join(root,id+".dpapi"));if(!bytes.length||bytes.length>2*1024*1024)throw new Error();target.fileReady=true;
    plain=await windowsProtection.unprotect(bytes);if(!Buffer.isBuffer(plain)||!plain.length||plain.length>1024*1024)throw new Error();target.dpapiReady=true;
    const envelope=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));target.jsonReady=true;
    target.fingerprintReady=envelope?.templateId===id&&envelope.command==="SELECT"&&Array.isArray(envelope.statements)&&envelope.statements.length===1&&fingerprintEnvelope(envelope)===fingerprint;
  }catch{}finally{plain?.fill(0);}
}
try{
  synthetic=Buffer.from("easypat-current-user-dpapi-diagnostic","utf8");protectedSynthetic=await windowsProtection.protect(synthetic);restored=await windowsProtection.unprotect(protectedSynthetic);result.syntheticRoundTrip=Buffer.isBuffer(restored)&&restored.equals(synthetic);
  const metadata=JSON.parse(await readFile(path.join(root,capture.requestMetadataFile),"utf8"));
  await inspect(result.main,"matter-detail.main-record.v1",candidates.find(item=>item.templateId==="matter-detail.main-record.v1")?.fingerprint);
  await inspect(result.document,"matter-detail.documents.v1",candidates.find(item=>item.templateId==="matter-detail.documents.v1")?.fingerprint);
  await inspect(result.intermediate,metadata.templateId,metadata.fingerprint);
  const allReady=result.syntheticRoundTrip&&[result.main,result.document,result.intermediate].every(item=>item.fingerprintReady);
  const status=allReady?"current-user-template-protection-ready":"current-user-template-protection-diagnostic";
  console.log(JSON.stringify({status,...result}));if(!allReady)process.exitCode=1;
}catch{console.error(JSON.stringify({status:"current-user-template-protection-failed",...result}));process.exitCode=1;}
finally{synthetic?.fill(0);protectedSynthetic?.fill(0);restored?.fill(0);}
