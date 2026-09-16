import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {importAuthenticationTemplateHandoff} from "./security/authentication-template-handoff.mjs";
import {windowsProtection} from "./security/windows-secrets.mjs";
try{
  const config=JSON.parse(readFileSync(new URL("../config/authentication-template.json",import.meta.url),"utf8"));
  const targetStore=createAuthenticationTemplateStore({expectedFingerprint:config.fingerprint,root:fileURLToPath(new URL("../.local/authentication-user/",import.meta.url))});
  console.log(JSON.stringify(await importAuthenticationTemplateHandoff({root:fileURLToPath(new URL("../.local/authentication-handoff/",import.meta.url)),targetStore,expectedFingerprint:config.fingerprint,protection:windowsProtection})));
}catch{console.error("AUTH_HANDOFF_IMPORT_FAILED");process.exitCode=1;}
