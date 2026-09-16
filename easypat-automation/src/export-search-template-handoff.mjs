import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createTemplateStore} from "./security/template-store.mjs";
import {exportReadTemplateHandoff} from "./security/read-template-handoff.mjs";

try{
  const candidates=JSON.parse(readFileSync(new URL("../config/protocol-observations/local-read-fingerprints.json",import.meta.url),"utf8")).candidates;
  const templateIds=["matter-search.exact-count.v1","matter-search.exact-result.v1"];
  const sourceStore=createTemplateStore({candidates,root:fileURLToPath(new URL("../.local/templates-user/",import.meta.url))});
  console.log(JSON.stringify(await exportReadTemplateHandoff({root:fileURLToPath(new URL("../.local/read-template-handoff/",import.meta.url)),sourceStore,candidates,templateIds})));
}catch{console.error("SEARCH_TEMPLATE_HANDOFF_EXPORT_FAILED");process.exitCode=1;}
