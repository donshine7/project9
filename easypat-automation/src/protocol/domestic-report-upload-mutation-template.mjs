import {decodeSqlStringLiteral,encodeSqlStringLiteral,encodeSqlUnicodeStringLiteral,parseInsertStatement,replaceInsertExpressions} from "./sql-insert-template.mjs";

const PROGRESS_COLUMNS=Object.freeze(["idx_parent","no_rec","d_rec","d_noti","rec_doc","judge","rec_memo","d_brief_due","d_brief","clerk_br","clerk_br_id","d_opinion_due","d_opinion","d_proc","proc_memo","n_extend","d_due","d_pre","pre_doc","d_pre_due","d_pre_rep","ck_ids","memo","pre_div","part","clerk_op","clerk_op_id","clerk_pr","clerk_pr_id","clerk","clerk_id","op_doc","sort"]);
const ATTACH_COLUMNS=Object.freeze(["DIV","GRP_KEY","DOC_NUM","DOC_NAME","REG_DATE","USR_DATE","FILE_NAME","FILE_NAME_UPLOAD","FILE_SIZE","MEMO","DOWN_COUNT","CK_OPEN","MUID","MUNAME"]);
const HISTORY_COLUMNS=Object.freeze(["idx_ori","idx_ori_sub","div","d_edit","obj_name","fd_name","value_ori","value_edit","id","name"]);
const REPORT_DOCUMENTS=new Set(["특허 출원 진행 요청","의견서 및 보정서 제출 요청"]),IDENTITY=/^\d{1,18}$/;

export class DomesticReportMutationTemplateError extends Error{constructor(code){super(code);this.name="DomesticReportMutationTemplateError";this.code=code;}}
const reject=code=>{throw new DomesticReportMutationTemplateError(code);};
const exactColumns=(actual,expected)=>actual.length===expected.length&&actual.every((column,index)=>column.toLowerCase()===expected[index].toLowerCase());
const exactKeys=(value,keys)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===[...keys].sort().join(",");
function identity(value){if(typeof value!=="string"||!IDENTITY.test(value))reject("DOMESTIC_REPORT_INTERNAL_IDENTITY_REJECTED");return encodeSqlStringLiteral(value);}
function date(value,{unpadded=false}={}){if(typeof value!=="string"||!/^(\d{4})-(\d{2})-(\d{2})$/.test(value))reject("DOMESTIC_REPORT_MUTATION_DATE_REJECTED");const [,year,month,day]=value.match(/^(\d{4})-(\d{2})-(\d{2})$/);return encodeSqlStringLiteral(unpadded?`${year}-${Number(month)}-${Number(day)}`:value);}
function common(input){if(input.assignee!=="장진태"||!REPORT_DOCUMENTS.has(input.reportDocument))reject("DOMESTIC_REPORT_MUTATION_CHOICE_REJECTED");}

export function compileProgressInsertBatch({envelope,matterIdentity,reportDate,assignee,reportDocument}){
  common({assignee,reportDocument});if(!envelope||envelope.templateId!=="matter-progress.insert-batch.v1"||envelope.command!=="OTHERS"||envelope.statements?.length!==2||!/^\s*SELECT\s+scope_identity\s*\(\s*\)\s+AS\s+(?:idx|'idx')\s*$/i.test(envelope.statements[1]))reject("DOMESTIC_REPORT_PROGRESS_TEMPLATE_REJECTED");
  const parsed=parseInsertStatement(envelope.statements[0],{expectedTable:"opms_app_proc"});if(!exactColumns(parsed.columns,PROGRESS_COLUMNS))reject("DOMESTIC_REPORT_PROGRESS_TEMPLATE_REJECTED");
  const values=Object.fromEntries(parsed.columns.map((column,index)=>[column.toLowerCase(),decodeSqlStringLiteral(parsed.expressions[index])]));
  if(values.clerk_op!=="장진태"||values.op_doc!=="특허 출원 진행 요청"||!/^\d{4}-\d{1,2}-\d{1,2}$/.test(values.d_opinion??""))reject("DOMESTIC_REPORT_PROGRESS_TEMPLATE_REJECTED");
  const statement=replaceInsertExpressions(parsed,{idx_parent:identity(matterIdentity),d_opinion:date(reportDate,{unpadded:true}),clerk_op:encodeSqlStringLiteral(assignee),op_doc:encodeSqlStringLiteral(reportDocument)});
  return Object.freeze({templateId:envelope.templateId,command:"OTHERS",statements:Object.freeze([statement,envelope.statements[1]])});
}

export function compileAttachmentInsert({envelope,matterIdentity,progressIdentity,assignee,fileName,fileSizeBytes,uploadedFileName}){
  if(!exactKeys({matterIdentity,progressIdentity,assignee,fileName,fileSizeBytes,uploadedFileName},["matterIdentity","progressIdentity","assignee","fileName","fileSizeBytes","uploadedFileName"])||assignee!=="장진태"||typeof fileName!=="string"||!/^[^\\/:*?"<>|\x00-\x1f]{1,260}\.pdf$/iu.test(fileName)||!Number.isSafeInteger(fileSizeBytes)||fileSizeBytes<5||fileSizeBytes>67108864||typeof uploadedFileName!=="string"||!/^upload\/app_proc\/20\d{2}\/(?:0[1-9]|1[0-2])\/(?:[0-2]\d|3[01])\/20\d{6}_\d{8}\.pdf$/i.test(uploadedFileName))reject("DOMESTIC_REPORT_ATTACHMENT_INPUT_REJECTED");
  if(!envelope||envelope.templateId!=="matter-progress.attach-insert.v1"||envelope.command!=="INSERT"||envelope.statements?.length!==1)reject("DOMESTIC_REPORT_ATTACHMENT_TEMPLATE_REJECTED");
  const parsed=parseInsertStatement(envelope.statements[0],{expectedTable:"opms_attach"});if(!exactColumns(parsed.columns,ATTACH_COLUMNS))reject("DOMESTIC_REPORT_ATTACHMENT_TEMPLATE_REJECTED");
  const values=Object.fromEntries(parsed.columns.map((column,index)=>[column.toLowerCase(),decodeSqlStringLiteral(parsed.expressions[index])]));
  if(values.muname!=="장진태"||values.file_size!=="0"||values.down_count!=="0"||values.file_name!=="test.txt")reject("DOMESTIC_REPORT_ATTACHMENT_TEMPLATE_REJECTED");
  const statement=replaceInsertExpressions(parsed,{GRP_KEY:identity(matterIdentity),DOC_NUM:identity(progressIdentity),FILE_NAME:encodeSqlUnicodeStringLiteral(fileName),FILE_NAME_UPLOAD:encodeSqlStringLiteral(uploadedFileName),FILE_SIZE:encodeSqlStringLiteral(String(fileSizeBytes)),MUNAME:encodeSqlStringLiteral(assignee)});
  return Object.freeze({templateId:envelope.templateId,command:"INSERT",statements:Object.freeze([statement])});
}

export function compileHistoryBatch({envelope,matterIdentity,progressIdentity,reportDate,assignee,reportDocument}){
  common({assignee,reportDocument});if(!envelope||envelope.templateId!=="matter-progress.history-batch.v1"||envelope.command!=="OTHERS"||envelope.statements?.length!==4)reject("DOMESTIC_REPORT_HISTORY_TEMPLATE_REJECTED");
  let dateRows=0,assigneeRows=0,documentRows=0;
  const statements=envelope.statements.map(statement=>{const parsed=parseInsertStatement(statement,{expectedTable:"opms_history"});if(!exactColumns(parsed.columns,HISTORY_COLUMNS))reject("DOMESTIC_REPORT_HISTORY_TEMPLATE_REJECTED");const index=parsed.columns.findIndex(column=>column.toLowerCase()==="value_edit"),captured=decodeSqlStringLiteral(parsed.expressions[index]);let replacement;if(captured==="2026-09-21"){dateRows++;replacement=date(reportDate);}else if(captured==="장진태"){assigneeRows++;replacement=encodeSqlStringLiteral(assignee);}else if(captured==="특허 출원 진행 요청"){documentRows++;replacement=encodeSqlStringLiteral(reportDocument);}else reject("DOMESTIC_REPORT_HISTORY_TEMPLATE_REJECTED");return replaceInsertExpressions(parsed,{idx_ori:identity(matterIdentity),idx_ori_sub:identity(progressIdentity),value_edit:replacement,name:encodeSqlStringLiteral(assignee)});});
  if(dateRows!==1||assigneeRows!==1||documentRows!==2)reject("DOMESTIC_REPORT_HISTORY_TEMPLATE_REJECTED");return Object.freeze({templateId:envelope.templateId,command:"OTHERS",statements:Object.freeze(statements)});
}

export const DOMESTIC_REPORT_MUTATION_TEMPLATE_COLUMNS=Object.freeze({progress:PROGRESS_COLUMNS,attachment:ATTACH_COLUMNS,history:HISTORY_COLUMNS});
