import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createDocumentDownloader} from "../src/protocol/document-downloader.mjs";

const allowedPolicy={
  allowedOperations:["download-document"],
  documentDownloadConstraints:{
    enabled:true,
    matterReference:"P261793",
    sourceTemplateId:"matter-detail.documents.v1",
    sameOriginOnly:true,
    freshVerifiedListRequired:true,
    maximumBytes:67108864,
    allowedSelections:[{position:2,expectedFileName:"P261545외_수임내역서(수정).jpg",expectedSha256:"a".repeat(64)}],
  },
};

function create(overrides={}){
  let reads=0,sessions=0,transports=0;
  const downloader=createDocumentDownloader({
    policy:allowedPolicy,
    readDocuments:async()=>{reads++;throw new Error("STOP_AFTER_POLICY");},
    getSessionCookie:async()=>{sessions++;return "unused";},
    transport:async()=>{transports++;return null;},
    ...overrides,
  });
  return {downloader,counts:()=>({reads,sessions,transports})};
}

test("disabled download policy blocks before list, session, or network access",async()=>{
  const {downloader,counts}=create({policy:{...allowedPolicy,documentDownloadConstraints:{...allowedPolicy.documentDownloadConstraints,enabled:false}}});
  await assert.rejects(()=>downloader.download({matterReference:"P261793",position:2,expectedFileName:"P261545외_수임내역서(수정).jpg"}),/DOCUMENT_DOWNLOAD_POLICY_REJECTED/);
  assert.deepEqual(counts(),{reads:0,sessions:0,transports:0});
});

test("only the exact policy selection passes the policy gate",async()=>{
  for(const input of [
    {matterReference:"P261793",position:1,expectedFileName:"P261545외_수임내역서(수정).jpg"},
    {matterReference:"P261793",position:2,expectedFileName:"다른파일.jpg"},
  ]){
    const {downloader,counts}=create();
    await assert.rejects(()=>downloader.download(input),/DOCUMENT_DOWNLOAD_POLICY_REJECTED/);
    assert.deepEqual(counts(),{reads:0,sessions:0,transports:0});
  }
});

test("the exact policy selection reaches the fresh document-list read",async()=>{
  const {downloader,counts}=create();
  await assert.rejects(()=>downloader.download({matterReference:"P261793",position:2,expectedFileName:"P261545외_수임내역서(수정).jpg"}),/DOCUMENT_DOWNLOAD_FAILED/);
  assert.deepEqual(counts(),{reads:1,sessions:0,transports:0});
});

test("an exact existing file is verified and returned without overwrite or GET",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"easypat-download-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from("image"),expectedSha256=createHash("sha256").update(bytes).digest("hex"),fileName="P261545외_수임내역서(수정).jpg";
  await writeFile(path.join(root,fileName),bytes);
  const row={DOC_NAME:"수임내역서",REG_DATE:"2026-05-21",FILE_NAME:fileName,FILE_NAME_UPLOAD:"upload/app_proc/2026/05/21/20260521_38152242.jpg",FILE_SIZE:String(bytes.length)};
  let sessions=0,transports=0;
  const policy={...allowedPolicy,documentDownloadConstraints:{...allowedPolicy.documentDownloadConstraints,allowedSelections:[{position:2,expectedFileName:fileName,expectedSha256}]}};
  const downloader=createDocumentDownloader({policy,root,readDocuments:async()=>({matterReference:"P261793",templateId:"matter-detail.documents.v1",columns:Object.keys(row),rows:[{...row,FILE_NAME:"other.jpg"},{...row}]}),getSessionCookie:async()=>{sessions++;return"unused";},transport:async()=>{transports++;return null;}});
  const result=await downloader.download({matterReference:"P261793",position:2,expectedFileName:fileName});
  assert.equal(result.downloaded,false);assert.equal(result.alreadyPresent,true);assert.equal(result.overwritten,false);assert.equal(result.sha256,expectedSha256);assert.equal(sessions,0);assert.equal(transports,0);
});
