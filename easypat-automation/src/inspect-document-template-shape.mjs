import { readFileSync } from "node:fs";
import { collectLiteralEqualities } from "./protocol/matter-linkage.mjs";
import { createReadOnlyBatch } from "./protocol/read-only-guard.mjs";
import { fingerprintEnvelope } from "./protocol/template-fingerprint.mjs";

const chunks=[];let size=0;
try{
  if(process.argv[2]!=="247")throw new Error();
  for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)throw new Error();chunks.push(chunk);}
  const statement=new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)),readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8")),fingerprints=readJson("../config/protocol-observations/local-read-fingerprints.json"),registry=readJson("../config/read-template-registry.json"),candidate=fingerprints.candidates.find(item=>item.sessionId===247),template=registry.templates.find(item=>item.templateId===candidate?.templateId),envelope={templateId:candidate.templateId,command:"SELECT",statements:[statement]};
  createReadOnlyBatch([envelope]);if(fingerprintEnvelope(envelope)!==candidate.fingerprint)throw new Error();
  const predicates=collectLiteralEqualities(statement),columns=[...new Set(predicates.map(item=>item.column))],responseColumns=columns.filter(column=>template.expectedResponseColumns.some(expected=>expected.toLowerCase()===column.toLowerCase()));
  if(!predicates.length)throw new Error();
  console.log(JSON.stringify({status:"document-template-shape-inspected",sessionId:247,templateId:candidate.templateId,candidateFingerprint:candidate.fingerprint,predicateCount:predicates.length,predicateColumns:columns,responseIdentityCandidateColumns:responseColumns,rawStatementsReturned:false,literalValuesReturned:false,executable:false,serverRequestSent:false}));
}catch{console.error(JSON.stringify({status:"rejected",failureStage:"document-shape",productionEnabled:false,rawValuesReturned:false}));process.exitCode=1;}
finally{chunks.forEach(chunk=>chunk.fill(0));}
