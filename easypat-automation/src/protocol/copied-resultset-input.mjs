import {parseResultset} from "./resultset.mjs";

const MASK=/!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;
const MAX_BYTES=2*1024*1024;
const PARSE_CODES=new Map([
  ["invalid resultset size","SIZE_REJECTED"],
  ["masked resultset cannot establish original values","MASKED_INPUT"],
  ["invalid resultset quoting","INVALID_QUOTING"],
  ["unterminated resultset quote","UNTERMINATED_QUOTE"],
  ["incomplete resultset metadata","INCOMPLETE_METADATA"],
  ["invalid resultset columns","INVALID_COLUMNS"],
  ["resultset field count mismatch","FIELD_COUNT_MISMATCH"],
  ["unsupported resultset type","UNSUPPORTED_TYPE"],
  ["invalid resultset lengths","INVALID_LENGTH_METADATA"],
]);

function parsed(text,inputFormat){
  if(typeof text!=="string"||!text.length||Buffer.byteLength(text)>2*1024*1024||MASK.test(text))throw new Error("COPIED_RESULTSET_REJECTED");
  const body=text.replace(/^\uFEFF/,"");
  try{return Object.freeze({result:parseResultset(body),inputFormat,pipelineNewlineRemoved:false});}
  catch(error){
    // A PowerShell string pipeline appends one record terminator. Remove only
    // that extra terminator, and only if the complete strict parser then passes.
    // Do not trim spaces, field separators, quoted data, or internal records.
    if(/(?:\r?\n){2}$/.test(body)){
      const withoutExtraTerminator=body.replace(/\r?\n$/,"");
      try{return Object.freeze({result:parseResultset(withoutExtraTerminator),inputFormat,pipelineNewlineRemoved:true});}catch{}
    }
    throw error;
  }
}

export function normalizeCopiedResultsetInput(raw){
  if(typeof raw!=="string"||!raw.length||Buffer.byteLength(raw)>2*1024*1024||MASK.test(raw))throw new Error("COPIED_RESULTSET_REJECTED");
  try{return parsed(raw,"raw-resultset-body");}catch{}
  const trimmed=raw.trim();
  if(trimmed.startsWith('"')&&trimmed.endsWith('"')){try{const decoded=JSON.parse(trimmed);if(typeof decoded==="string")return parsed(decoded,"quoted-json-string");}catch{}}
  const headerEnd=raw.indexOf("\r\n\r\n"),headers=raw.slice(0,headerEnd);
  if(headerEnd>=0&&headerEnd<=32768&&/^HTTP\/1\.[01] 200(?: [^\r\n]*)?\r\n/.test(headers)&&
     /^Content-Type:\s*text\/resultset(?:;[^\r\n]*)?\s*$/im.test(headers)){
    try{return parsed(raw.slice(headerEnd+4),"http-raw-body");}catch{}
  }
  // Arbitrary leading records must never be skipped: they may be copied shell
  // text or a damaged resultset, not a verified response wrapper.
  throw new Error("COPIED_RESULTSET_REJECTED");
}

// Only counts and fixed classifications leave this diagnostic. It does not
// print field names, snippets, raw exceptions, hashes of rows, or row values.
export function diagnoseCopiedResultsetInput(raw){
  if(typeof raw!=="string"||Buffer.byteLength(raw)>MAX_BYTES){
    return Object.freeze({accepted:false,failureCode:"SIZE_OR_TYPE_REJECTED",rawValuesReturned:false});
  }
  const body=raw.replace(/^\uFEFF/,""),lines=body.split(/\r\n|\n/);
  let normalized,strictParseCode="OK";
  try{parseResultset(body);}catch(error){strictParseCode=PARSE_CODES.get(error?.message)??"UNSUPPORTED_INPUT";}
  try{normalized=normalizeCopiedResultsetInput(raw);}catch{}
  const count=pattern=>(body.match(pattern)??[]).length;
  let failureCode=normalized?null:"RESULTSET_FORMAT_REJECTED";
  if(!normalized){
    if(!body.trim())failureCode="EMPTY_INPUT";
    else if(MASK.test(body))failureCode="MASKED_INPUT";
    else if(/Get-Clipboard|\$[A-Za-z_][\w]*\s*\||TrimStart\(|-match\s|\.mjs[\"']/i.test(body))failureCode="SHELL_COMMAND_TEXT";
    else if(/^(?:SELECT|WITH)\b/i.test(body.trimStart()))failureCode="REQUEST_SQL_NOT_RESPONSE";
    else if(!body.includes("\x01"))failureCode="RESULTSET_SEPARATOR_MISSING";
    else failureCode=strictParseCode;
  }
  return Object.freeze({accepted:!!normalized,inputFormat:normalized?.inputFormat??"unrecognized",failureCode,strictParseCode,
    byteCount:Buffer.byteLength(body),lineFeedCount:count(/\n/g),sohCount:count(/\x01/g),tabCount:count(/\t/g),
    escapedSohCount:count(/\\u0001|\\x01/g),visibleSohCount:count(/␁|\[SOH\]/g),containsNul:body.includes("\x00"),
    masked:MASK.test(body),hasTrailingBlankRecord:/(?:\r?\n){2}$/.test(body),
    firstFourLineFieldCounts:lines.slice(0,4).map(line=>line.split("\x01").length),
    pipelineNewlineRemoved:normalized?.pipelineNewlineRemoved??false,rawValuesReturned:false});
}
