import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {fingerprintEnvelope} from "./protocol/template-fingerprint.mjs";
import {windowsProtection} from "./security/windows-secrets.mjs";
import {DOCUMENT_GROUP_CAPTURE as capture} from "./protocol/document-group-capture-version.mjs";

const root=path.resolve(fileURLToPath(new URL("../.local/templates-user/",import.meta.url))),metadataPath=path.join(root,capture.requestMetadataFile),templatePath=path.join(root,capture.templateId+".dpapi");
let plain=null,stage="metadata";
const result={metadataReady:false,protectedFileReady:false,dpapiUnprotectReady:false,jsonReady:false,templateIdMatched:false,commandMatched:false,statementCountMatched:false,fingerprintMatched:false,rawValuesReturned:false,serverRequestsPerformed:0};
try{
  const metadata=JSON.parse(await readFile(metadataPath,"utf8"));if(metadata?.templateId!==capture.templateId||!/^[a-f0-9]{64}$/.test(metadata?.fingerprint??""))throw new Error();result.metadataReady=true;
  stage="protected-file";const protectedBytes=await readFile(templatePath);if(!protectedBytes.length||protectedBytes.length>2*1024*1024)throw new Error();result.protectedFileReady=true;
  stage="dpapi-unprotect";plain=await windowsProtection.unprotect(protectedBytes);if(!Buffer.isBuffer(plain)||!plain.length||plain.length>1024*1024)throw new Error();result.dpapiUnprotectReady=true;
  stage="json";const envelope=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));result.jsonReady=true;
  result.templateIdMatched=envelope?.templateId===metadata.templateId;result.commandMatched=envelope?.command===metadata.command;result.statementCountMatched=Array.isArray(envelope?.statements)&&envelope.statements.length===metadata.statementCount;result.fingerprintMatched=fingerprintEnvelope(envelope)===metadata.fingerprint;
  if(!result.templateIdMatched||!result.commandMatched||!result.statementCountMatched||!result.fingerprintMatched)throw new Error();
  console.log(JSON.stringify({status:"document-group-intermediate-template-ready",...result}));
}catch{console.error(JSON.stringify({status:"document-group-intermediate-template-failed",failureStage:stage,...result}));process.exitCode=1;}
finally{plain?.fill(0);plain=null;}
