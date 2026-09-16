import {parseResultset} from "./protocol/resultset.mjs";
try{
  if(process.stdin.isTTY&&typeof process.stdin.setRawMode==="function"){process.stdin.setRawMode(true);console.log("READY");}
  process.stdin.setEncoding("utf8");let line="";for await(const value of process.stdin){line+=value;const end=line.indexOf("\n");if(end>=0){line=line.slice(0,end);break;}if(Buffer.byteLength(line)>4*1024*1024)throw new Error();}if(!line||Buffer.byteLength(line)>4*1024*1024)throw new Error();const payload=JSON.parse(line.replace(/\r$/,""));if(!payload||Object.keys(payload).sort().join(",")!=="contentType,text"||!/^text\/resultset(?:;|$)/i.test(payload.contentType)||typeof payload.text!=="string"||payload.text.includes("!!!sanitized!!!"))throw new Error();
  const result=parseResultset(payload.text),key=result.columns.find(column=>column.toLowerCase()==="ourref"),exact=!!key&&result.rows.length===1&&result.rows[0][key]==="P261793";
  console.log(JSON.stringify({status:"captured-main-response-inspected",rowCount:result.rows.length,columnCount:result.columns.length,columns:result.columns,ourrefColumnPresent:!!key,exactMatterMatch:exact,rawRowValuesReturned:false}));
}catch{console.error("CAPTURED_MAIN_RESPONSE_INSPECTION_FAILED");process.exitCode=1;}
