import {extractAuthenticationBatch} from "./authentication-batch.mjs";
import {scanAuthenticationSql} from "./authentication-shape.mjs";
import {projectAuthenticationResponse} from "./authentication-response.mjs";
function literal(raw){const m=/^(?:N)?'((?:[^']|'')*)'$/i.exec(raw);if(!m)throw new Error();return m[1].replaceAll("''","'");}
export function assessCapturedAuthenticationExchange({requestCopied,responseText,responseContentType,framing="observed-jbori",cookieContinuity}){
  try{
    const {envelope}=extractAuthenticationBatch(requestCopied);
    const login=scanAuthenticationSql(envelope.statements[1]),rightsQuery=scanAuthenticationSql(envelope.statements[2]);
    const expected=literal(login.literalSpans[5].raw);
    if(expected!==literal(login.literalSpans[1].raw)||expected!==literal(rightsQuery.literalSpans[15].raw))throw new Error();
    const keys=["_uread","_uwrite","_udelete","_uprint","_uattach"];
    const triples=Array.from({length:5},(_,i)=>rightsQuery.literalSpans.slice(i*3,i*3+3).map(span=>literal(span.raw)));
    if(triples.some(t=>t.length!==3||t[1]===t[2]))throw new Error();
    const rightsConventions=Object.fromEntries(keys.map((key,i)=>[key,{trueValue:triples[i][1],falseValue:triples[i][2]}]));
    const projection=projectAuthenticationResponse({text:responseText,contentType:responseContentType,framing},{rightsConventions});
    const identityStatus=projection.identityIds.length===0?"no-matching-user-row":projection.identityIds.length===1&&projection.identityIds[0]===expected?"identity-row-matched":"identity-row-mismatched-or-ambiguous";
    const exchangeMatched=identityStatus==="identity-row-matched"&&cookieContinuity===true;
    return {status:exchangeMatched?"captured-successful-session-exchange-observed":"authentication-outcome-not-established",identityStatus,cookieContinuity:cookieContinuity===true,rightsRowCount:projection.rights.length,
      sensitiveValuesIncluded:false,capturedExchangeMatched:exchangeMatched,liveAuthenticationVerified:false,executable:false};
  }catch{throw new Error("AUTH_EXCHANGE_REJECTED");}
}
