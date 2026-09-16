import readline from "node:readline";
import { createTemplateStore } from "./security/template-store.mjs";
import { inspectCapturedSearchForms, summarizeCapturedSearchForms } from "./protocol/search-template-capture.mjs";

async function readPrivateLine(){
  if(process.stdin.isTTY&&typeof process.stdin.setRawMode==="function"){
    process.stdin.setRawMode(true);process.stdin.resume();
    const chunks=[];let total=0;
    try{
      for await(const chunk of process.stdin){
        const buffer=Buffer.from(chunk),cr=buffer.indexOf(13),lf=buffer.indexOf(10),newline=cr<0?lf:lf<0?cr:Math.min(cr,lf),part=newline<0?buffer:buffer.subarray(0,newline);
        total+=part.length;if(total>256*1024)throw new Error();chunks.push(Buffer.from(part));
        if(newline>=0)break;
      }
      return Buffer.concat(chunks).toString("utf8").replace(/\r$/,"");
    }finally{chunks.forEach(chunk=>chunk.fill(0));process.stdin.setRawMode(false);process.stdin.pause();}
  }
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
  try{for await(const value of input)return value;return undefined;}finally{input.close();}
}

try{
  const line=await readPrivateLine();
  if(typeof line!=="string"||Buffer.byteLength(line)>256*1024)throw new Error();
  const items=inspectCapturedSearchForms(JSON.parse(line));
  const candidates=items.map(item=>({templateId:item.spec.templateId,command:"SELECT",statementCount:1,fingerprint:item.definition.baseFingerprint}));
  const store=createTemplateStore({candidates});
  const storage=[];
  for(const item of items){
    let alreadyStored=false;
    try{await store.load(item.spec.templateId);alreadyStored=true;}catch{}
    if(!alreadyStored)await store.save(item.spec.templateId,item.envelope);
    await store.load(item.spec.templateId);
    storage.push({templateId:item.spec.templateId,stored:true,alreadyStored,roundTripVerified:true,protection:"Windows-DPAPI-CurrentUser"});
  }
  console.log(JSON.stringify({...summarizeCapturedSearchForms(items),storage,plaintextWritten:false}));
}catch{
  console.error('{"status":"search-template-import-rejected","rawStatementsReturned":false,"plaintextWritten":false}');
  process.exitCode=1;
}
