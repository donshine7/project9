import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createAuthenticationTemplateStore} from "./security/authentication-template-store.mjs";
import {exportAuthenticationTemplateHandoff} from "./security/authentication-template-handoff.mjs";
try{
  const config=JSON.parse(readFileSync(new URL("../config/authentication-template.json",import.meta.url),"utf8"));
  const sourceStore=createAuthenticationTemplateStore({expectedFingerprint:config.fingerprint,root:fileURLToPath(new URL("../.local/authentication/",import.meta.url))});
  console.log(JSON.stringify(await exportAuthenticationTemplateHandoff({root:fileURLToPath(new URL("../.local/authentication-handoff/",import.meta.url)),sourceStore,expectedFingerprint:config.fingerprint})));
}catch{console.error("AUTH_HANDOFF_EXPORT_FAILED");process.exitCode=1;}
