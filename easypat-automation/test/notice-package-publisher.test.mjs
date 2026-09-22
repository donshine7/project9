import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createVerifiedDocumentSelection} from "../src/protocol/document-selection-context.mjs";
import {createNoticePackagePublisher} from "../src/workflow/notice-package-publisher.mjs";

test("downloads a freshly verified package, validates its ZIP, and publishes without overwrite",async()=>{
  const destinationRoot=await mkdtemp(path.join(os.tmpdir(),"notice-publisher-destination-")),projectRoot=path.resolve(fileURLToPath(new URL("../",import.meta.url))),localRoot=path.join(projectRoot,".local");
  const {mkdir}=await import("node:fs/promises");await mkdir(localRoot,{recursive:true});const staging=await mkdtemp(path.join(localRoot,"notice-publisher-test-")),destination=path.join(destinationRoot,"destination");await mkdir(destination);let prepared=0,downloaded=0;
  const expectedItems=[{position:1,documentName:"중간서류",registeredAt:"2026-06-26 09:45:20.000",fileName:"P261252_의견제출통지서.pdf",fileSizeBytes:9},{position:2,documentName:"중간서류",registeredAt:"2026-06-26 09:45:21.000",fileName:"official.fin",fileSizeBytes:6}];
  const policy={noticePackageDownloadConstraints:{enabled:true,sourceTemplateId:"matter-detail.attachments.all.v1",freshVerifiedListRequired:true,sameOriginOnly:true,maximumBytes:67108864,maximumPackageBytes:536870912,allowMissingContentTypeForVerifiedAttachment:true,overwriteAllowed:false,automaticRetryEnabled:false,callerSuppliedUploadPathAllowed:false,destinationRoot:destination}};
  const publisher=createNoticePackagePublisher({policy,stagingRoot:staging,getSessionCookie:async()=>"JSESSIONID=test",preparePackage:async()=>{prepared++;return{matterReference:"P261252",noticeDate:"2026-06-25",dueDate:"2026-10-25",count:2,items:expectedItems,selections:[createVerifiedDocumentSelection({matterReference:"P261252",position:1,fileName:expectedItems[0].fileName,uploadPath:"upload/app/2026/06/26/a.pdf",fileSizeBytes:9,extension:"pdf"}),createVerifiedDocumentSelection({matterReference:"P261252",position:2,fileName:expectedItems[1].fileName,uploadPath:"upload/app/2026/06/26/b.fin",fileSizeBytes:6,extension:"fin"})]};},transport:async({extension})=>{downloaded++;const bytes=extension==="pdf"?Buffer.from("%PDF-test"):Buffer.from("office");return{bytes,size:bytes.length,contentType:extension==="pdf"?"application/pdf":"application/octet-stream"};}});
  const input={matterReference:"P261252",progressDocument:"의견제출통지서",oaSequence:1,noticeDate:"2026-06-25",dueDate:"2026-10-25",sequence:"1",expectedItems};
  try{const result=await publisher.publish(input);assert.equal(prepared,1);assert.equal(downloaded,2);assert.equal(result.itemCount,2);assert.equal(result.overwritten,false);assert.equal((await readFile(result.destinationPath)).length,result.fileSizeBytes);await assert.rejects(publisher.publish(input),error=>error.code==="NOTICE_DESTINATION_EXISTS");}
  finally{await rm(staging,{recursive:true,force:true});await rm(destinationRoot,{recursive:true,force:true});}
});
