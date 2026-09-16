import { extractAuthenticationBatch } from "./authentication-batch.mjs";
import { compileAuthenticationBinding } from "./authentication-binding.mjs";
import { scanAuthenticationSql } from "./authentication-shape.mjs";

export const AUTHENTICATION_BATCH_SHAPES=Object.freeze([
  "SELECT * , CONVERT ( VARCHAR ( <value> ) , getDate ( ) , <value> ) AS dd FROM opms_code_setting WHERE del_flag = <value>",
  null, // Pinned separately by compileAuthenticationBinding.
  "SELECT urightcode , uright , ( CASE WHEN uread = <value> THEN <value> ELSE <value> END ) AS _uread , ( CASE WHEN uwrite = <value> THEN <value> ELSE <value> END ) AS _uwrite , ( CASE WHEN udelete = <value> THEN <value> ELSE <value> END ) AS _udelete , ( CASE WHEN uprint = <value> THEN <value> ELSE <value> END ) AS _uprint , ( CASE WHEN uattach = <value> THEN <value> ELSE <value> END ) AS _uattach FROM opms_login_member_right WHERE id = <value>",
  "SELECT getDate ( ) AS today",
  "SELECT CONVERT ( VARCHAR , GETDATE ( ) , <value> ) AS nowtime",
]);
function literal(raw) {
  const match=/^(N?)'((?:[^']|'')*)'$/i.exec(raw);
  if(!match)throw new Error();
  return {prefix:match[1],value:match[2].replaceAll("''","'")};
}
function makeBatchBinder(fixed, login, rightsParts, rightsPrefix, rightsConstants) {
  return Object.freeze({
    bind(input) {
      try {
        const loginSql=login.bind(input); // Applies the credential limits and quoting checks.
        const rightsSql=rightsParts[0]+rightsPrefix+"'"+input.username.replaceAll("'","''")+"'"+rightsParts[1];
        const scan=scanAuthenticationSql(rightsSql);
        if(scan.shape.toUpperCase()!==AUTHENTICATION_BATCH_SHAPES[2].toUpperCase() || scan.commentCount ||
          rightsConstants.some((v,i)=>scan.literalSpans[i].raw!==v) || literal(scan.literalSpans[15].raw).value!==input.username)throw new Error();
        const sqls=[fixed[0],loginSql,rightsSql,fixed[1],fixed[2]];
        return new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"5",command:"OTHERS",...Object.fromEntries(sqls.map((s,i)=>['sql'+i,s]))}).toString();
      } catch {throw new Error("AUTH_BATCH_BINDING_REJECTED");}
    },
    summary:Object.freeze({status:"batch-binding-compiled",statementCount:5,usernameSlotCount:3,passwordSlotCount:1,fixedLiteralCount:23,
      capturedUsernamesEqual:true,originalCredentialsRetainedInTemplate:false,valuesIncluded:false,executable:false,authenticationVerified:false}),
  });
}

export function compileAuthenticationBatch(copied) {
  try {
    const {envelope}=extractAuthenticationBatch(copied), sqls=envelope.statements;
    const scans=sqls.map(scanAuthenticationSql);
    for(const i of [0,2,3,4])if(scans[i].commentCount||scans[i].shape.toUpperCase()!==AUTHENTICATION_BATCH_SHAPES[i].toUpperCase())throw new Error();
    const login=compileAuthenticationBinding(sqls[1]);
    const user=literal(scans[1].literalSpans[1].raw).value;
    const password=literal(scans[1].literalSpans[6].raw).value;
    const rightsSpan=scans[2].literalSpans[15], rightsUser=literal(rightsSpan.raw);
    if(rightsUser.value!==user)throw new Error();
    const rightsParts=[sqls[2].slice(0,rightsSpan.start),sqls[2].slice(rightsSpan.end)];
    const fixed=[sqls[0],sqls[3],sqls[4]];
    if([...fixed,...rightsParts].some(part=>part.includes(user)||part.includes(password)))throw new Error();
    return makeBatchBinder(fixed,login,rightsParts,rightsUser.prefix,scans[2].literalSpans.slice(0,15).map(s=>s.raw));
  } catch {throw new Error("AUTH_BATCH_TEMPLATE_REJECTED");}
}
