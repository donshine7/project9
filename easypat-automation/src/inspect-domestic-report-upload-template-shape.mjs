import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {createMutationTemplateStore} from "./security/mutation-template-store.mjs";
import {decodeSqlStringLiteral,parseInsertStatement} from "./protocol/sql-insert-template.mjs";

const kinds=["progress-insert-batch","attach-insert","history-batch"],root=fileURLToPath(new URL("../.local/templates-user/",import.meta.url));
try{
  const results=[];
  for(const kind of kinds){
    const metadata=JSON.parse(await readFile(`${root}domestic-report-upload-${kind}.json`,"utf8")),candidate={templateId:metadata.templateId,command:metadata.command,statementCount:metadata.statementCount,fingerprint:metadata.fingerprint},store=createMutationTemplateStore({candidates:[candidate]}),envelope=await store.load(candidate.templateId),statements=[];
    for(const statement of envelope.statements){
      if(!/^\s*INSERT\s+INTO\s+/i.test(statement)){statements.push({kind:"generated-identity-read",length:statement.length});continue;}
      const parsed=parseInsertStatement(statement),expressions=parsed.expressions.map((expression,index)=>{const literal=decodeSqlStringLiteral(expression),column=parsed.columns[index];let classification="fixed-expression",format=null;if(literal!==null){classification="fixed-string";if(literal==="2026-09-21")classification="captured-report-date";else if(/^\d{4}-\d{1,2}-\d{1,2}$/.test(literal)){classification="captured-date-format";format="YYYY-M-D";}else if(/^\d{8}$/.test(literal)){classification="captured-date-format";format="YYYYMMDD";}else if(literal==="특허 출원 진행 요청")classification="captured-report-document";else if(literal==="test.txt")classification="captured-file-name";else if(literal==="장진태")classification="captured-assignee";else if(/^\d+$/.test(literal))classification="numeric-string";}return{column,classification,format,length:literal===null?expression.length:literal.length,fingerprint:createHash("sha256").update(literal??expression,"utf8").digest("hex").slice(0,12)};});
      statements.push({kind:"insert",table:parsed.table,columnCount:parsed.columns.length,expressions});
    }
    results.push({kind,templateId:candidate.templateId,statements});
  }
  console.log(JSON.stringify({status:"domestic-report-upload-template-shape-ready",templates:results,rawValuesReturned:false,plaintextStored:false,serverRequestsPerformed:0}));
}catch{console.error(JSON.stringify({status:"domestic-report-upload-template-shape-failed",rawValuesReturned:false,plaintextStored:false,serverRequestsPerformed:0}));process.exitCode=1;}
