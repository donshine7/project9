import {diagnoseCopiedSqlInput} from "./protocol/copied-sql-input.mjs";

const chunks=[];let size=0;
try{
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  const raw=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
  console.log(JSON.stringify({status:"copied-sql-input-diagnosed",...diagnoseCopiedSqlInput(raw),serverRequestsPerformed:0}));
}catch{console.error(JSON.stringify({status:"copied-sql-input-diagnostic-rejected",rawValueReturned:false,serverRequestsPerformed:0}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));}
