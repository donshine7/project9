import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createVerifiedDocumentSelection} from "../src/protocol/document-selection-context.mjs";
import {createGenericDocumentDownloader} from "../src/protocol/generic-document-downloader.mjs";

const policy={allowedOperations:["download-document"],mutationOperationsEnabled:false,arbitrarySqlEnabled:false,genericDocumentConstraints:{enabled:true},genericDownloadConstraints:{enabled:true,mcpExposureEnabled:true,sourceTemplateId:"matter-detail.documents.v1",freshVerifiedDocumentListRequired:true,sameOriginOnly:true,maximumBytes:67108864,overwriteAllowed:false,automaticRetryEnabled:false,callerSuppliedUploadPathAllowed:false}};
const input={matterReference:"PT261130",position:1,expectedFileName:"수임내역서.pdf"};
const selection=()=>createVerifiedDocumentSelection({matterReference:"PT261130",position:1,fileName:"수임내역서.pdf",uploadPath:"upload/app_proc/2026/09/16/verified.pdf",fileSizeBytes:5,extension:"pdf"});

test("generic downloader blocks while its production policy is disabled",async()=>{
  let prepared=0;const downloader=createGenericDocumentDownloader({policy:{...policy,genericDownloadConstraints:{...policy.genericDownloadConstraints,enabled:false}},prepareDownload:async()=>{prepared++;return selection();},getSessionCookie:async()=>"unused",transport:async()=>null});
  await assert.rejects(()=>downloader.download(input),/GENERIC_DOWNLOAD_POLICY_REJECTED/);assert.equal(prepared,0);
});

test("generic downloader writes a fresh verified selection without exposing the server path",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"easypat-generic-download-"));t.after(()=>rm(root,{recursive:true,force:true}));const bytes=Buffer.from("12345");let sessions=0,transports=0;
  const downloader=createGenericDocumentDownloader({policy,root,prepareDownload:async()=>selection(),getSessionCookie:async()=>{sessions++;return"JSESSIONID=verified";},transport:async request=>{transports++;assert.equal(request.uploadPath,"upload/app_proc/2026/09/16/verified.pdf");return{bytes:Buffer.from(bytes),size:5,contentType:"application/pdf"};}});
  const result=await downloader.download(input);assert.equal(result.matterReference,"PT261130");assert.equal(result.downloaded,true);assert.equal(result.overwritten,false);assert.equal(sessions,1);assert.equal(transports,1);assert.deepEqual(await readFile(result.path),bytes);assert.doesNotMatch(JSON.stringify(result),/upload\/app_proc/);
});

test("generic downloader never overwrites an existing destination",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"easypat-generic-download-"));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,"placeholder"),"safe");
  const matterRoot=path.join(root,"PT261130");const {mkdir}=await import("node:fs/promises");await mkdir(matterRoot);await writeFile(path.join(matterRoot,"수임내역서.pdf"),"old");let sessions=0,transports=0;
  const downloader=createGenericDocumentDownloader({policy,root,prepareDownload:async()=>selection(),getSessionCookie:async()=>{sessions++;return"unused";},transport:async()=>{transports++;return null;}});
  await assert.rejects(()=>downloader.download(input),/GENERIC_DOWNLOAD_DESTINATION_EXISTS/);assert.equal(sessions,0);assert.equal(transports,0);assert.equal(String(await readFile(path.join(matterRoot,"수임내역서.pdf"))),"old");
});
