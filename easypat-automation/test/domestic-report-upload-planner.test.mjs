import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createDomesticReportUploadPlanner} from "../src/workflow/domestic-report-upload-planner.mjs";

const basePolicy=JSON.parse(await readFile(new URL("../config/domestic-report-upload-policy.json",import.meta.url),"utf8"));
const pdf=Buffer.from("%PDF-1.7\nsynthetic upload test\n%%EOF\n","ascii");

async function fixture({policy=basePolicy,existing=[],executeMutation,now=Date.parse("2026-09-20T15:30:00Z")}={}){
  const root=await mkdtemp(path.join(os.tmpdir(),"easypat-upload-preview-"));
  await writeFile(path.join(root,"보고서.pdf"),pdf);
  const calls={domestic:0,duplicates:0,mutations:0};
  const planner=createDomesticReportUploadPlanner({
    policy,
    stagingRoot:root,
    now:()=>now,
    issueApprovalId:()=>"approval-1234567890",
    verifyDomesticMatter:async({matterReference})=>{calls.domestic++;return{matterReference,domestic:true};},
    listExistingReports:async()=>{calls.duplicates++;return structuredClone(existing);},
    executeMutation:executeMutation??(async input=>{calls.mutations++;return{status:"verified",matterReference:input.matterReference,reportDate:input.reportDate,assignee:input.assignee,reportDocument:input.reportDocument,fileName:input.fileName,fileSizeBytes:input.fileSizeBytes};}),
  });
  return{root,planner,calls,cleanup:()=>rm(root,{recursive:true,force:true})};
}

const request={matterReference:"P261048",reportDocument:"특허 출원 진행 요청",stagedFileName:"보고서.pdf"};

test("previews the exact domestic-report workflow with Korea-date and Jang Jintae defaults",async()=>{
  const value=await fixture();
  try{
    const result=await value.planner.preview(request);
    assert.equal(result.status,"protocol-capture-required");
    assert.equal(result.reportDate,"2026-09-21");
    assert.equal(result.reportDateDefaulted,true);
    assert.equal(result.assignee,"장진태");
    assert.equal(result.assigneeDefaulted,true);
    assert.equal(result.reportDocument,"특허 출원 진행 요청");
    assert.equal(result.fileName,"보고서.pdf");
    assert.equal(result.fileSizeBytes,pdf.length);
    assert.match(result.sha256,/^[a-f0-9]{64}$/);
    assert.equal(result.approvalId,null);
    assert.equal(result.commitEnabled,false);
    assert.equal(result.serverMutationPerformed,false);
    assert.equal(result.rawFileContentReturned,false);
    assert.equal(result.localPathReturned,false);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(value.root.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"));
    assert.deepEqual(value.calls,{domestic:1,duplicates:1,mutations:0});
  }finally{await value.cleanup();}
});

test("accepts the second allowlisted report document and an explicit valid date",async()=>{
  const value=await fixture();
  try{
    const result=await value.planner.preview({...request,reportDate:"2026-09-19",assignee:"장진태",reportDocument:"의견서 및 보정서 제출 요청"});
    assert.equal(result.reportDate,"2026-09-19");
    assert.equal(result.reportDateDefaulted,false);
    assert.equal(result.assigneeDefaulted,false);
  }finally{await value.cleanup();}
});

test("rejects unknown fields, path traversal, unsupported choices, invalid dates and non-PDF content",async()=>{
  const value=await fixture();
  try{
    for(const input of [
      {...request,sql:"UPDATE x"},
      {...request,stagedFileName:"..\\보고서.pdf"},
      {...request,assignee:"다른 담당자"},
      {...request,reportDocument:"임의 보고서"},
      {...request,reportDate:"2026-02-30"},
    ])await assert.rejects(value.planner.preview(input));
    await writeFile(path.join(value.root,"가짜.pdf"),Buffer.from("not a pdf","ascii"));
    await assert.rejects(value.planner.preview({...request,stagedFileName:"가짜.pdf"}),error=>error.code==="DOMESTIC_REPORT_FILE_REJECTED");
    assert.equal(value.calls.mutations,0);
  }finally{await value.cleanup();}
});

test("rejects non-domestic matters and duplicate reports before any mutation",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"easypat-upload-preview-"));
  await writeFile(path.join(root,"보고서.pdf"),pdf);
  try{
    const nonDomestic=createDomesticReportUploadPlanner({policy:basePolicy,stagingRoot:root,verifyDomesticMatter:async({matterReference})=>({matterReference,domestic:false}),listExistingReports:async()=>[]});
    await assert.rejects(nonDomestic.preview(request),error=>error.code==="DOMESTIC_REPORT_MATTER_REJECTED");
    const duplicate=(await fixture({existing:[{reportDate:"2026-09-21",assignee:"장진태",reportDocument:"특허 출원 진행 요청",fileName:"보고서.pdf",sha256:null}]}));
    try{await assert.rejects(duplicate.planner.preview(request),error=>error.code==="DOMESTIC_REPORT_DUPLICATE_REJECTED");assert.equal(duplicate.calls.mutations,0);}finally{await duplicate.cleanup();}
  }finally{await rm(root,{recursive:true,force:true});}
});

test("an enabled candidate binds a one-use approval to the unchanged file and verifies the read-back",async()=>{
  const enabled=structuredClone(basePolicy);
  enabled.status="cross-matter-live-validated";enabled.commitEnabled=true;enabled.mcpExposureEnabled=true;
  for(const key of Object.keys(enabled.protocolEvidence))enabled.protocolEvidence[key]=true;
  enabled.completedDistinctLiveValidations=2;enabled.validatedMatterReferences=["P261048","P261315"];
  const value=await fixture({policy:enabled});
  try{
    const preview=await value.planner.preview(request);
    assert.equal(preview.status,"approval-required");
    assert.equal(preview.approvalId,"approval-1234567890");
    const result=await value.planner.commit({approvalId:preview.approvalId});
    assert.equal(result.status,"uploaded-and-verified");
    assert.equal(result.serverMutationPerformed,true);
    assert.equal(result.readBackVerified,true);
    assert.equal(result.automaticRetryPerformed,false);
    assert.equal(value.calls.mutations,1);
    await assert.rejects(value.planner.commit({approvalId:preview.approvalId}),error=>error.code==="DOMESTIC_REPORT_APPROVAL_REJECTED");
  }finally{await value.cleanup();}
});

test("consumes the approval and refuses commit if the staged file changes",async()=>{
  const enabled=structuredClone(basePolicy);enabled.commitEnabled=true;enabled.mcpExposureEnabled=true;
  for(const key of Object.keys(enabled.protocolEvidence))enabled.protocolEvidence[key]=true;
  enabled.completedDistinctLiveValidations=2;enabled.validatedMatterReferences=["P261048","P261315"];
  const value=await fixture({policy:enabled});
  try{
    const preview=await value.planner.preview(request);
    await writeFile(path.join(value.root,"보고서.pdf"),Buffer.from("%PDF-1.7\nchanged\n%%EOF\n","ascii"));
    await assert.rejects(value.planner.commit({approvalId:preview.approvalId}),error=>error.code==="DOMESTIC_REPORT_APPROVAL_STALE");
    assert.equal(value.calls.mutations,0);
  }finally{await value.cleanup();}
});
