import {getEasyPatCredentialStatus} from "./security/windows-secrets.mjs";

try{
  const status=await getEasyPatCredentialStatus();
  console.log(JSON.stringify({...status,secretValueRead:false,target:"EasyPAT/Automation"}));
}catch{
  console.error("CREDENTIAL_STATUS_CHECK_FAILED");
  process.exitCode=1;
}
