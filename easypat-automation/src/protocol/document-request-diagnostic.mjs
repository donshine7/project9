import {collectLiteralEqualities} from "./matter-linkage.mjs";

export function diagnoseDocumentRequest(statement){
  const text=typeof statement==="string"?statement:"";
  let predicateInspectionSupported=false,predicateCount=null;
  try{predicateCount=collectLiteralEqualities(text).length;predicateInspectionSupported=true;}catch{}
  return Object.freeze({
    startsWithReadKeyword:/^(?:SELECT|WITH)\b/i.test(text.trimStart()),
    fromClauseObserved:/\bFROM\s+(?:\[?\w+\]?\.)*\[?\w+\]?/i.test(text),
    shellSyntaxDetected:/SELECT\|WITH|Get-Clipboard|TrimStart\(|-match\s|\$[A-Za-z_]|\.mjs[\"']|\|\s*&/i.test(text),
    predicateInspectionSupported,predicateCount,rawValuesReturned:false,executable:false,
  });
}
