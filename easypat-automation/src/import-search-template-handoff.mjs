import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createTemplateStore} from "./security/template-store.mjs";
import {importReadTemplateHandoff} from "./security/read-template-handoff.mjs";
import {windowsProtection} from "./security/windows-secrets.mjs";

try{
  const candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates;
  const templateIds=["matter-search.exact-count.v1","matter-search.exact-result.v1"];
  const targetStore=createTemplateStore({candidates,root:fileURLToPath(new URL("../.local/templates-user/",import.meta.url))});
  console.log(JSON.stringify(await importReadTemplateHandoff({root:fileURLToPath(new URL("../.local/read-template-handoff/",import.meta.url)),targetStore,candidates,templateIds,protection:windowsProtection})));
}catch{console.error("SEARCH_TEMPLATE_HANDOFF_IMPORT_FAILED");process.exitCode=1;}
