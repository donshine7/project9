const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;
const READ=/^(SELECT|WITH)\b/i;
const READ_ANY=/\b(SELECT|WITH)\b/i;
const SHELL=/SELECT\s*\|\s*WITH|Get-Clipboard|TrimStart\(|-match\s|\$[A-Za-z_]|\.mjs["']|\|\s*&/i;
const FORBIDDEN=/\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE|EXEC(?:UTE)?|CALL|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|INTO|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i;

function accepted(sql,inputFormat){
  const value=sql.replace(/^\uFEFF/,"").trim();
  if(!value||value.length>1024*1024||MASK.test(value)||!READ.test(value)||FORBIDDEN.test(value)||SHELL.test(value))throw new Error("COPIED_SQL_INPUT_REJECTED");
  return Object.freeze({sql:value,inputFormat});
}

export function normalizeCopiedSqlInput(raw){
  if(typeof raw!=="string"||!raw.length||raw.length>1024*1024||MASK.test(raw))throw new Error("COPIED_SQL_INPUT_REJECTED");
  const value=raw.replace(/^\uFEFF/,"").trim();
  if(READ.test(value)&&!/^(?:SELECT|WITH)(?:%[0-9a-f]{2}|\+)/i.test(value))return accepted(value,"raw-sql-value");
  if(value.startsWith('"')&&value.endsWith('"')){
    try{const decoded=JSON.parse(value);if(typeof decoded==="string"&&READ.test(decoded.trim()))return accepted(decoded,"quoted-json-string");}catch{}
  }
  const labelled=/^sql\s*(?::|=|\r?\n)\s*([\s\S]+)$/i.exec(value);
  if(labelled&&READ.test(labelled[1].trim()))return accepted(labelled[1],"labelled-sql-value");
  const tab=value.indexOf("\t");
  if(tab>0&&value.slice(0,tab).trim().toLowerCase()==="sql")return accepted(value.slice(tab+1),"fiddler-name-value-row");
  if(value.includes("=")&&value.includes("&")){
    const form=new URLSearchParams(value),sqlValues=form.getAll("sql"),commandValues=form.getAll("command"),countValues=form.getAll("count");
    const forbiddenNames=[...form.keys()].some(key=>/password|passwd|pwd|cookie|authorization|session/i.test(key));
    if(!forbiddenNames&&sqlValues.length===1&&commandValues.length===1&&commandValues[0].trim().toUpperCase()==="SELECT"&&
       (countValues.length===0||(countValues.length===1&&countValues[0]==="1")))return accepted(sqlValues[0],"urlencoded-form");
  }
  if(/%(?:2[0379A-F]|3[BCD-F]|5[B-D]|7[B-D])/i.test(value)||/^(?:SELECT|WITH)\+/i.test(value)){
    try{const decoded=decodeURIComponent(value.replaceAll("+"," "));if(READ.test(decoded.trim()))return accepted(decoded,"percent-encoded-sql-value");}catch{}
  }
  // Never extract a SELECT word from unknown leading text. A copied shell
  // command containing the SELECT|WITH regex is not a captured SQL request.
  throw new Error("COPIED_SQL_INPUT_REJECTED");
}

export function diagnoseCopiedSqlInput(raw){
  const value=typeof raw==="string"?raw.replace(/^\uFEFF/,"").trim():"";
  let normalized=null;try{normalized=normalizeCopiedSqlInput(raw);}catch{}
  const count=pattern=>(value.match(pattern)??[]).length;
  return Object.freeze({accepted:!!normalized,inputFormat:normalized?.inputFormat??"unrecognized",nonEmpty:value.length>0,byteCount:Buffer.byteLength(value),lineFeedCount:count(/\n/g),tabCount:count(/\t/g),equalsCount:count(/=/g),ampersandCount:count(/&/g),masked:MASK.test(value),startsWithReadKeyword:READ.test(value),readKeywordAnywhere:READ_ANY.test(value),forbiddenTokenDetected:FORBIDDEN.test(value),looksLikeUrlencodedForm:value.includes("=")&&value.includes("&"),looksLikeNameValueRow:/^sql\t/i.test(value),looksLikeLabelledSql:/^sql\s*(?::|=|\r?\n)/i.test(value),looksPercentEncoded:/%[0-9a-f]{2}/i.test(value),looksQuotedString:value.startsWith('"')&&value.endsWith('"'),looksLikeUrl:/^https?:\/\//i.test(value),looksLikeFiddlerInterface:/\b(?:HTTP Inspector|Agent Inspector|Live Traffic|Form-Data|Overview)\b/i.test(value),looksLikePowerShellPrompt:/\bPS\s+[^\r\n>]+>/i.test(value),containsNul:value.includes("\u0000"),looksLikeResultset:value.includes("\u0001"),looksLikeJson:/^[{[]/.test(value),looksLikeHtml:/^<!(?:doctype)|^<html\b/i.test(value),rawValueReturned:false});
}
