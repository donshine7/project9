import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/WindowsSecretBroker.ps1", import.meta.url));
function broker(operation, bytes) {
  if (process.platform !== "win32") return Promise.reject(new Error("WINDOWS_REQUIRED"));
  if (bytes && (!Buffer.isBuffer(bytes) || bytes.length > 2 * 1024 * 1024)) return Promise.reject(new Error("SECRET_INPUT_TOO_LARGE"));
  return new Promise((resolve,reject)=>{
    let settled=false, total=0;
    const output=[];
    const child=spawn(process.env.EASYPAT_PWSH_PATH || "pwsh.exe",["-NoLogo","-NoProfile","-NonInteractive","-File",script,"-Operation",operation],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);output.forEach(b=>b.fill(0));if(error)reject(new Error("WINDOWS_SECRET_OPERATION_FAILED"));else resolve(value);};
    const timer=setTimeout(()=>{child.kill();finish(true);},15000);
    child.on("error",()=>finish(true));child.stdin.on("error",()=>finish(true));
    child.stderr.on("data",()=>{});
    child.stdout.on("data",chunk=>{total+=chunk.length;if(total>4*1024*1024){child.kill();finish(true);}else output.push(chunk);});
    child.on("close",code=>{
      if(settled)return;
      if(code!==0){finish(true);return;}
      try { finish(false,JSON.parse(Buffer.concat(output).toString("utf8"))); } catch { finish(true); }
    });
    child.stdin.end(bytes?JSON.stringify({data:bytes.toString("base64")}):"");
  });
}

export const windowsProtection=Object.freeze({
  async protect(bytes){const result=await broker("Protect",bytes);if(typeof result.data!=="string")throw new Error("INVALID_SECRET_RESULT");return Buffer.from(result.data,"base64");},
  async unprotect(bytes){const result=await broker("Unprotect",bytes);if(typeof result.data!=="string")throw new Error("INVALID_SECRET_RESULT");return Buffer.from(result.data,"base64");},
});

// Reports only whether the dedicated entry has the required fields. The broker
// does not copy or decode the credential blob for this operation.
export async function getEasyPatCredentialStatus({runBroker=broker}={}){
  const result=await runBroker("CredentialStatus");
  if(!result||typeof result.available!=="boolean"||typeof result.usernamePresent!=="boolean"||typeof result.passwordPresent!=="boolean"||(!result.available&&(result.usernamePresent||result.passwordPresent)))throw new Error("INVALID_CREDENTIAL_STATUS");
  return Object.freeze({available:result.available,usernamePresent:result.usernamePresent,passwordPresent:result.passwordPresent});
}

// Returned credentials stay in the authentication adapter's process, never in tool output.
export async function readEasyPatCredential(){
  const result=await broker("ReadCredential");
  if(typeof result.username!=="string"||!result.username||typeof result.password!=="string"||!result.password)throw new Error("INVALID_CREDENTIAL_RESULT");
  return result;
}
