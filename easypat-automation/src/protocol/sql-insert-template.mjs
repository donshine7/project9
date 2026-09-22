const IDENTIFIER=/^[A-Za-z_][A-Za-z0-9_]*$/;

export class SqlInsertTemplateError extends Error{constructor(code){super(code);this.name="SqlInsertTemplateError";this.code=code;}}
const reject=code=>{throw new SqlInsertTemplateError(code);};

function splitTopLevel(value){
  const items=[];let start=0,depth=0,quoted=false;
  for(let index=0;index<value.length;index++){
    const char=value[index];
    if(quoted){if(char==="'"&&value[index+1]==="'"){index++;continue;}if(char==="'")quoted=false;continue;}
    if(char==="'"){quoted=true;continue;}if(char==="("){depth++;continue;}if(char===")"){depth--;if(depth<0)reject("SQL_INSERT_SYNTAX_REJECTED");continue;}if(char===","&&depth===0){items.push(value.slice(start,index).trim());start=index+1;}
  }
  if(quoted||depth!==0)reject("SQL_INSERT_SYNTAX_REJECTED");items.push(value.slice(start).trim());if(items.some(item=>!item))reject("SQL_INSERT_SYNTAX_REJECTED");return items;
}

export function parseInsertStatement(statement,{expectedTable}={}){
  if(typeof statement!=="string"||statement.length>256*1024||statement.includes("\0")||/;\s*\S/.test(statement))reject("SQL_INSERT_INPUT_REJECTED");
  const match=/^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^]*?)\)\s*VALUES\s*\(([^]*)\)\s*;?\s*$/i.exec(statement);
  if(!match)reject("SQL_INSERT_SYNTAX_REJECTED");const table=match[1].toLowerCase();if(expectedTable&&table!==expectedTable.toLowerCase())reject("SQL_INSERT_TABLE_REJECTED");
  const columns=splitTopLevel(match[2]);if(columns.some(column=>!IDENTIFIER.test(column))||new Set(columns.map(column=>column.toLowerCase())).size!==columns.length)reject("SQL_INSERT_COLUMNS_REJECTED");
  const expressions=splitTopLevel(match[3]);if(expressions.length!==columns.length)reject("SQL_INSERT_ARITY_REJECTED");
  return Object.freeze({table,columns:Object.freeze(columns),expressions:Object.freeze(expressions)});
}

export function decodeSqlStringLiteral(expression){
  if(typeof expression!=="string"||! /^(?:N)?'(?:[^']|'')*'$/i.test(expression))return null;
  const start=/^[Nn]'/.test(expression)?2:1;return expression.slice(start,-1).replace(/''/g,"'");
}

export function encodeSqlStringLiteral(value){
  if(typeof value!=="string"||value.includes("\0"))reject("SQL_INSERT_VALUE_REJECTED");return `'${value.replace(/'/g,"''")}'`;
}

export function encodeSqlUnicodeStringLiteral(value){return `N${encodeSqlStringLiteral(value)}`;}

export function replaceInsertExpressions(parsed,replacements){
  if(!parsed||!Array.isArray(parsed.columns)||!Array.isArray(parsed.expressions)||!replacements||typeof replacements!=="object"||Array.isArray(replacements))reject("SQL_INSERT_BINDING_REJECTED");
  const byLower=new Map(parsed.columns.map((column,index)=>[column.toLowerCase(),index])),expressions=[...parsed.expressions];
  for(const [column,value] of Object.entries(replacements)){const index=byLower.get(column.toLowerCase());if(index===undefined||typeof value!=="string"||!value.trim())reject("SQL_INSERT_BINDING_REJECTED");expressions[index]=value;}
  return `INSERT INTO ${parsed.table} (${parsed.columns.join(",")}) VALUES (${expressions.join(",")})`;
}
