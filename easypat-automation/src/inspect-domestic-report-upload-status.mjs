import {readFileSync} from "node:fs";

try{
  const policy=JSON.parse(readFileSync(new URL("../config/domestic-report-upload-policy.json",import.meta.url),"utf8"));
  const evidence=policy.protocolEvidence??{},capturedEvidenceCount=Object.values(evidence).filter(value=>value===true).length;
  process.stdout.write(JSON.stringify({
    status:policy.status,
    previewImplemented:policy.previewEnabled===true,
    commitEnabled:policy.commitEnabled===true,
    mcpExposureEnabled:policy.mcpExposureEnabled===true,
    defaultReportDate:"today-Asia/Seoul",
    defaultAssignee:policy.defaults?.assignee??null,
    allowedReportDocuments:Array.isArray(policy.allowedReportDocuments)?[...policy.allowedReportDocuments]:[],
    allowedFileTypes:Array.isArray(policy.filePolicy?.allowedExtensions)?[...policy.filePolicy.allowedExtensions]:[],
    capturedEvidenceCount,
    requiredEvidenceCount:Object.keys(evidence).length,
    completedDistinctLiveValidations:policy.completedDistinctLiveValidations??0,
    requiredDistinctLiveValidations:policy.requiredDistinctLiveValidations??0,
    serverMutationPerformed:false,
  })+"\n");
}catch{
  process.stdout.write(JSON.stringify({status:"domestic-report-upload-status-failed",serverMutationPerformed:false})+"\n");
  process.exitCode=1;
}
