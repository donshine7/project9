import { credentialColumns } from "./response-schema.mjs";
import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { fingerprintEnvelope } from "./template-fingerprint.mjs";
import { normalizeExactMatterReference } from "./matter-reference.mjs";
import { normalizeExactApplicationNumber } from "./application-number.mjs";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TEMPLATE_ID = /^[a-z0-9.-]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MASK = /!!!sanitized!!!|\[REDACTED\]|\*\*\*SANITIZED\*\*\*/i;
const identities = new WeakMap();

function tokenize(statement) {
  if (typeof statement !== "string" || !statement.length || statement.length > 1024 * 1024) {
    throw new Error("PARAMETERIZED_TEMPLATE_REJECTED");
  }
  const tokens = [];
  let i = 0;
  while (i < statement.length) {
    const rest = statement.slice(i);
    let match;
    if ((match = /^\s+/.exec(rest))) { i += match[0].length; continue; }
    // Parameterized templates do not accept comments. Their absence is part of
    // the small, reviewable structure that is fingerprinted before binding.
    if (rest.startsWith("--") || rest.startsWith("/*")) throw new Error("PARAMETERIZED_TEMPLATE_REJECTED");
    if ((match = /^(N)?'((?:[^']|'')*)'/i.exec(rest))) {
      tokens.push({kind:"literal", value:match[2].replace(/''/g, "'"), unicode:!!match[1], start:i, end:i+match[0].length});
      i += match[0].length; continue;
    }
    if ((match = /^\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(rest))) {
      tokens.push({kind:"identifier", value:match[1], start:i, end:i+match[0].length});
      i += match[0].length; continue;
    }
    if ((match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      tokens.push({kind:"identifier", value:match[0], start:i, end:i+match[0].length});
      i += match[0].length; continue;
    }
    if ((match = /^\d+(?![\w.])/.exec(rest))) {
      tokens.push({kind:"number", value:match[0], start:i, end:i+match[0].length});
      i += match[0].length; continue;
    }
    if (/[.,=()<>+*/;%:-]/.test(rest[0])) {
      tokens.push({kind:"symbol", value:rest[0], start:i, end:i+1}); i++; continue;
    }
    throw new Error("PARAMETERIZED_TEMPLATE_REJECTED");
  }
  return tokens;
}

function parameterization(definition, source) {
  if (!definition || !TEMPLATE_ID.test(definition.templateId ?? "") || definition.command !== "SELECT" ||
      definition.statementCount !== 1 || !SHA256.test(definition.baseFingerprint ?? "") ||
      typeof definition.productionEnabled !== "boolean") throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
  const binding = definition.parameterization;
  const allowedModes=source==="matter-reference"?["single-literal-equality","repeated-like-contains"]:
    source==="trusted-derived-identity"?["single-scalar-equality","scalar-equality-as-literal"]:
    ["single-literal-equality","single-scalar-equality","multi-scalar-equality"];
  if (!binding || !allowedModes.includes(binding.mode) || binding.source !== source) throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
  if(binding.mode==="multi-scalar-equality"){
    if(source!=="verified-search-identity"||!Array.isArray(binding.predicateColumns)||binding.predicateColumns.length<2||binding.predicateColumns.length>8||
       binding.predicateColumns.some(column=>!NAME.test(column))||new Set(binding.predicateColumns.map(column=>column.toLowerCase())).size!==binding.predicateColumns.length)throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
    if(binding.expectedOccurrenceCounts!==undefined){
      const counts=binding.expectedOccurrenceCounts;
      if(!counts||typeof counts!=="object"||Array.isArray(counts)||Object.keys(counts).sort().join(",")!==[...binding.predicateColumns].sort().join(",")||
         Object.values(counts).some(count=>!Number.isSafeInteger(count)||count<1||count>32)||Object.values(counts).reduce((sum,count)=>sum+count,0)>64)throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
    }
  }else if(!NAME.test(binding.predicateColumn??""))throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
  if(binding.mode==="repeated-like-contains"&&(!Number.isSafeInteger(binding.expectedOccurrenceCount)||binding.expectedOccurrenceCount<2||binding.expectedOccurrenceCount>16)){
    throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
  }
  return binding;
}

function verifyBase(envelope, definition) {
  if (!envelope || envelope.templateId !== definition.templateId || envelope.command !== "SELECT" ||
      !Array.isArray(envelope.statements) || envelope.statements.length !== 1 ||
      fingerprintEnvelope(envelope) !== definition.baseFingerprint) {
    throw new Error("PARAMETERIZED_BASE_REJECTED");
  }
  createReadOnlyBatch([envelope]);
  return envelope.statements[0];
}

function uniqueBindingToken(statement, predicateColumn,{allowNumber=false}={}) {
  const tokens = tokenize(statement), matches = [];
  for (let i = 1; i < tokens.length - 1; i++) {
    const left=tokens[i-1], operator=tokens[i], right=tokens[i+1], next=tokens[i+2];
    if (operator.kind!=="symbol" || operator.value!=="=" || left.kind!=="identifier" ||
        left.value.toLowerCase()!==predicateColumn.toLowerCase() || !(right.kind==="literal"||(allowNumber&&right.kind==="number"))) continue;
    if (["<",">","!","="].includes(tokens[i-2]?.value)) continue;
    const terminates=!next || (next.kind==="symbol"&&[")",";"].includes(next.value)) ||
      (next.kind==="identifier"&&/^(AND|OR|ORDER|GROUP|HAVING|UNION|FOR|OPTION)$/i.test(next.value));
    if (terminates) matches.push({tokens,index:i+1,token:right});
  }
  if (matches.length!==1 || !matches[0].token.value.length || MASK.test(matches[0].token.value) ||
      (matches[0].token.kind==="number"&&!/^(?:0|[1-9]\d{0,18})$/.test(matches[0].token.value))) {
    throw new Error("PARAMETERIZED_SLOT_REJECTED");
  }
  return matches[0];
}

function repeatedLikeTokens(statement,predicateColumn,expectedCount){
  const tokens=tokenize(statement),matches=[];
  for(let i=1;i<tokens.length-1;i++){
    const left=tokens[i-1],operator=tokens[i],right=tokens[i+1],next=tokens[i+2];
    if(operator.kind!=="identifier"||operator.value.toUpperCase()!=="LIKE"||left.kind!=="identifier"||
       left.value.toLowerCase()!==predicateColumn.toLowerCase()||right.kind!=="literal")continue;
    const terminates=!next||(next.kind==="symbol"&&[")",";"].includes(next.value))||
      (next.kind==="identifier"&&/^(AND|OR|ORDER|GROUP|HAVING|UNION|FOR|OPTION)$/i.test(next.value));
    if(terminates)matches.push({index:i+1,token:right,leftIndex:i-1,left});
  }
  if(matches.length!==expectedCount||matches.some(match=>!match.token.value.length||MASK.test(match.token.value))){
    throw new Error("PARAMETERIZED_SLOT_REJECTED");
  }
  return {tokens,matches};
}

function sqlLiteral(value, unicode) {
  if (typeof value!=="string" || !value.length || value.length>1024 || /[\p{Cc}\p{Cs}]/u.test(value) || MASK.test(value)) {
    throw new Error("PARAMETER_VALUE_REJECTED");
  }
  if (!unicode && /[^\x20-\x7e]/.test(value)) throw new Error("PARAMETER_VALUE_REJECTED");
  return `${unicode?"N":""}'${value.replaceAll("'", "''")}'`;
}

function structure(tokens, boundIndex) {
  const indices=new Set(Array.isArray(boundIndex)?boundIndex:[boundIndex]);
  return tokens.map((token,index)=>indices.has(index)?`${token.kind}:<BOUND>`:`${token.kind}:${token.value}`).join("\u0000");
}

function bindRepeatedLike(statement,predicateColumn,value,baseValue,expectedCount){
  const slots=repeatedLikeTokens(statement,predicateColumn,expectedCount),expected=`%${baseValue}%`,replacementValue=`%${value}%`;
  if(slots.matches.some(match=>match.token.value!==expected))throw new Error("PARAMETERIZED_SLOT_REJECTED");
  let compiled=statement;
  for(const match of [...slots.matches].sort((a,b)=>b.token.start-a.token.start)){
    const replacement=sqlLiteral(replacementValue,match.token.unicode);
    compiled=compiled.slice(0,match.token.start)+replacement+compiled.slice(match.token.end);
  }
  const rebound=repeatedLikeTokens(compiled,predicateColumn,expectedCount);
  if(rebound.matches.some(match=>match.token.value!==replacementValue)||
     structure(slots.tokens,slots.matches.map(match=>match.index))!==structure(rebound.tokens,rebound.matches.map(match=>match.index))){
    throw new Error("PARAMETERIZED_STRUCTURE_REJECTED");
  }
  createReadOnlyBatch([{templateId:"compiled.read",command:"SELECT",statements:[compiled]}]);
  return compiled;
}

function bindDerivedRepeatedLike(statement,{sourcePredicateColumn,targetPredicateColumn,value,baseValue,expectedCount}){
  if(!NAME.test(sourcePredicateColumn)||!NAME.test(targetPredicateColumn)||sourcePredicateColumn.toLowerCase()===targetPredicateColumn.toLowerCase()){
    throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
  }
  const slots=repeatedLikeTokens(statement,sourcePredicateColumn,expectedCount),expected=`%${baseValue}%`,replacementValue=`%${value}%`;
  if(slots.matches.some(match=>match.token.value!==expected))throw new Error("PARAMETERIZED_SLOT_REJECTED");
  const edits=[];
  for(const match of slots.matches){
    edits.push({start:match.left.start,end:match.left.end,value:targetPredicateColumn});
    edits.push({start:match.token.start,end:match.token.end,value:sqlLiteral(replacementValue,match.token.unicode)});
  }
  let compiled=statement;
  for(const edit of edits.sort((a,b)=>b.start-a.start))compiled=compiled.slice(0,edit.start)+edit.value+compiled.slice(edit.end);
  const rebound=repeatedLikeTokens(compiled,targetPredicateColumn,expectedCount);
  const originalBound=slots.matches.flatMap(match=>[match.leftIndex,match.index]);
  const reboundBound=rebound.matches.flatMap(match=>[match.leftIndex,match.index]);
  if(rebound.matches.some(match=>match.token.value!==replacementValue)||
     structure(slots.tokens,originalBound)!==structure(rebound.tokens,reboundBound))throw new Error("PARAMETERIZED_STRUCTURE_REJECTED");
  createReadOnlyBatch([{templateId:"compiled.read",command:"SELECT",statements:[compiled]}]);
  return compiled;
}

function bind(statement, predicateColumn, value, expectedBaseValue,{allowNumber=false}={}) {
  const slot=uniqueBindingToken(statement,predicateColumn,{allowNumber});
  if (expectedBaseValue!==undefined && slot.token.value!==expectedBaseValue) throw new Error("PARAMETERIZED_SLOT_REJECTED");
  const replacement=slot.token.kind==="number"
    ?(/^(?:0|[1-9]\d{0,18})$/.test(value)?value:(()=>{throw new Error("PARAMETER_VALUE_REJECTED");})())
    :sqlLiteral(value,slot.token.unicode);
  const compiled=statement.slice(0,slot.token.start)+replacement+statement.slice(slot.token.end);
  const rebound=uniqueBindingToken(compiled,predicateColumn,{allowNumber});
  if (rebound.token.value!==value || rebound.token.kind!==slot.token.kind || structure(slot.tokens,slot.index)!==structure(rebound.tokens,rebound.index)) {
    throw new Error("PARAMETERIZED_STRUCTURE_REJECTED");
  }
  createReadOnlyBatch([{templateId:"compiled.read",command:"SELECT",statements:[compiled]}]);
  return compiled;
}

function bindAsLiteral(statement,predicateColumn,value){
  const slot=uniqueBindingToken(statement,predicateColumn,{allowNumber:true});
  const nonAscii=/[^\x20-\x7e]/.test(value),replacement=sqlLiteral(value,slot.token.kind==="literal"?(slot.token.unicode||nonAscii):nonAscii);
  const compiled=statement.slice(0,slot.token.start)+replacement+statement.slice(slot.token.end);
  const rebound=uniqueBindingToken(compiled,predicateColumn);
  const normalizedStructure=(tokens,index)=>tokens.map((token,position)=>position===index?"<BOUND>":`${token.kind}:${token.value}`).join("\u0000");
  if(rebound.token.value!==value||normalizedStructure(slot.tokens,slot.index)!==normalizedStructure(rebound.tokens,rebound.index))throw new Error("PARAMETERIZED_STRUCTURE_REJECTED");
  createReadOnlyBatch([{templateId:"compiled.read",command:"SELECT",statements:[compiled]}]);return compiled;
}

function bindMany(statement,predicateColumns,value){
  const slots=predicateColumns.map(column=>uniqueBindingToken(statement,column,{allowNumber:true}));
  if(new Set(slots.map(slot=>slot.token.value)).size!==1||new Set(slots.map(slot=>slot.token.kind)).size!==1)throw new Error("PARAMETERIZED_SLOT_REJECTED");
  let compiled=statement;
  for(const slot of [...slots].sort((a,b)=>b.token.start-a.token.start)){
    const replacement=slot.token.kind==="number"
      ?(/^(?:0|[1-9]\d{0,18})$/.test(value)?value:(()=>{throw new Error("PARAMETER_VALUE_REJECTED");})())
      :sqlLiteral(value,slot.token.unicode);
    compiled=compiled.slice(0,slot.token.start)+replacement+compiled.slice(slot.token.end);
  }
  const rebound=predicateColumns.map(column=>uniqueBindingToken(compiled,column,{allowNumber:true}));
  const originalStructure=structure(slots[0].tokens,slots.map(slot=>slot.index)),reboundStructure=structure(rebound[0].tokens,rebound.map(slot=>slot.index));
  if(rebound.some((slot,index)=>slot.token.value!==value||slot.token.kind!==slots[index].token.kind)||originalStructure!==reboundStructure)throw new Error("PARAMETERIZED_STRUCTURE_REJECTED");
  createReadOnlyBatch([{templateId:"compiled.read",command:"SELECT",statements:[compiled]}]);
  return compiled;
}

function repeatedEqualitySlots(statement,predicateColumn,expectedCount){
  const tokens=tokenize(statement),matches=[];
  for(let i=1;i<tokens.length-1;i++){
    const left=tokens[i-1],operator=tokens[i],right=tokens[i+1],next=tokens[i+2];
    if(operator.kind!=="symbol"||operator.value!=="="||left.kind!=="identifier"||left.value.toLowerCase()!==predicateColumn.toLowerCase()||!(right.kind==="literal"||right.kind==="number"))continue;
    if(["<",">","!","="].includes(tokens[i-2]?.value))continue;
    const terminates=!next||(next.kind==="symbol"&&[")",";"].includes(next.value))||(next.kind==="identifier"&&/^(AND|OR|ORDER|GROUP|HAVING|UNION|FOR|OPTION)$/i.test(next.value));
    if(terminates)matches.push({tokens,index:i+1,token:right});
  }
  if(matches.length!==expectedCount||matches.some(slot=>!slot.token.value.length||MASK.test(slot.token.value)||(slot.token.kind==="number"&&!/^(?:0|[1-9]\d{0,18})$/.test(slot.token.value))))throw new Error("PARAMETERIZED_SLOT_REJECTED");
  return matches;
}

function bindManyRepeated(statement,binding,value){
  const groups=binding.predicateColumns.map(column=>repeatedEqualitySlots(statement,column,binding.expectedOccurrenceCounts?.[column]??1)),slots=groups.flat();
  if(new Set(slots.map(slot=>slot.token.value)).size!==1||new Set(slots.map(slot=>slot.token.kind)).size!==1)throw new Error("PARAMETERIZED_SLOT_REJECTED");
  let compiled=statement;
  for(const slot of [...slots].sort((a,b)=>b.token.start-a.token.start)){
    const replacement=slot.token.kind==="number"?(/^(?:0|[1-9]\d{0,18})$/.test(value)?value:(()=>{throw new Error("PARAMETER_VALUE_REJECTED");})()):sqlLiteral(value,slot.token.unicode);
    compiled=compiled.slice(0,slot.token.start)+replacement+compiled.slice(slot.token.end);
  }
  const reboundGroups=binding.predicateColumns.map(column=>repeatedEqualitySlots(compiled,column,binding.expectedOccurrenceCounts?.[column]??1)),rebound=reboundGroups.flat();
  if(rebound.some((slot,index)=>slot.token.value!==value||slot.token.kind!==slots[index].token.kind)||structure(slots[0].tokens,slots.map(slot=>slot.index))!==structure(rebound[0].tokens,rebound.map(slot=>slot.index)))throw new Error("PARAMETERIZED_STRUCTURE_REJECTED");
  createReadOnlyBatch([{templateId:"compiled.read",command:"SELECT",statements:[compiled]}]);return compiled;
}

function compiledEnvelope(envelope, statement) {
  return Object.freeze({templateId:envelope.templateId,command:"SELECT",statements:Object.freeze([statement])});
}

export function bindMatterReferenceSearchTemplate({envelope, definition, matterReference}) {
  const binding=parameterization(definition,"matter-reference");
  const target=normalizeExactMatterReference(matterReference);
  const base=normalizeExactMatterReference(binding.baseMatterReference);
  const statement=verifyBase(envelope,definition);
  const compiled=binding.mode==="repeated-like-contains"
    ?bindRepeatedLike(statement,binding.predicateColumn,target,base,binding.expectedOccurrenceCount)
    :bind(statement,binding.predicateColumn,target,base);
  return compiledEnvelope(envelope,compiled);
}

// Derive a fixed application-number lookup from the already fingerprinted
// matter search template. Only the verified LIKE predicate identifiers and
// their literal values can change; SELECT columns and every other token remain
// structurally identical.
export function bindApplicationNumberSearchTemplate({envelope,definition,applicationNumber,derivation}){
  const binding=parameterization(definition,"matter-reference");
  if(binding.mode!=="repeated-like-contains"||!derivation||
     derivation.sourcePredicateColumn!==binding.predicateColumn||
     derivation.targetPredicateColumn!=="n_app")throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
  const target=normalizeExactApplicationNumber(applicationNumber);
  const base=normalizeExactMatterReference(binding.baseMatterReference);
  const statement=verifyBase(envelope,definition);
  return compiledEnvelope(envelope,bindDerivedRepeatedLike(statement,{
    sourcePredicateColumn:derivation.sourcePredicateColumn,
    targetPredicateColumn:derivation.targetPredicateColumn,
    value:target,
    baseValue:base,
    expectedCount:binding.expectedOccurrenceCount,
  }));
}

export function readMatterSearchCandidateCount({result,definition,maxCandidates=500}){
  if(!definition||!TEMPLATE_ID.test(definition.templateId??"")||!NAME.test(definition.responseCountColumn??"")||
     result?.templateId!==definition.templateId||!Array.isArray(result.columns)||!Array.isArray(result.rows)||result.rows.length!==1||
     credentialColumns(result.columns).length||!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>5000){
    throw new Error("SEARCH_COUNT_REJECTED");
  }
  if(Array.isArray(definition.expectedResponseColumns)&&
     (definition.expectedResponseColumns.length!==result.columns.length||definition.expectedResponseColumns.some((column,index)=>column!==result.columns[index]))){
    throw new Error("SEARCH_COUNT_REJECTED");
  }
  const columns=result.columns.filter(column=>column.toLowerCase()===definition.responseCountColumn.toLowerCase());
  if(columns.length!==1)throw new Error("SEARCH_COUNT_REJECTED");
  const value=result.rows[0]?.[columns[0]];
  if(typeof value!=="string"||!/^(?:0|[1-9]\d*)$/.test(value))throw new Error("SEARCH_COUNT_REJECTED");
  const count=Number(value);
  if(!Number.isSafeInteger(count)||count<1||count>maxCandidates)throw new Error("SEARCH_COUNT_REJECTED");
  return count;
}

export function createMatterIdentityContext({matterReference, searchResult, definition}) {
  const matter=normalizeExactMatterReference(matterReference);
  if (!definition || !TEMPLATE_ID.test(definition.templateId??"") || !NAME.test(definition.responseMatterColumn??"") ||
      !NAME.test(definition.responseIdentityColumn??"") || searchResult?.templateId!==definition.templateId ||
      !Array.isArray(searchResult.columns) || !Array.isArray(searchResult.rows) || searchResult.rows.length<1 || searchResult.rows.length>500 ||
      credentialColumns(searchResult.columns).length) throw new Error("SEARCH_IDENTITY_REJECTED");
  if (Array.isArray(definition.expectedResponseColumns) &&
      (definition.expectedResponseColumns.length!==searchResult.columns.length ||
       definition.expectedResponseColumns.some((column,index)=>column!==searchResult.columns[index]))) {
    throw new Error("SEARCH_IDENTITY_REJECTED");
  }
  const column=(name)=>searchResult.columns.filter(item=>item.toLowerCase()===name.toLowerCase());
  const matterColumns=column(definition.responseMatterColumn), identityColumns=column(definition.responseIdentityColumn);
  if (matterColumns.length!==1 || identityColumns.length!==1) throw new Error("SEARCH_IDENTITY_REJECTED");
  const exactRows=searchResult.rows.filter(row=>row?.[matterColumns[0]]===matter);
  if(exactRows.length!==1)throw new Error("SEARCH_IDENTITY_REJECTED");
  const row=exactRows[0], identity=row[identityColumns[0]];
  if (typeof identity!=="string" || !identity.length || identity.length>1024 ||
      /[\p{Cc}\p{Cs}]/u.test(identity) || MASK.test(identity)) throw new Error("SEARCH_IDENTITY_REJECTED");
  const context=Object.freeze({
    matterReference:matter,
    sourceTemplateId:definition.templateId,
    verified:true,
    internalIdentityIncluded:false,
  });
  identities.set(context,{column:definition.responseIdentityColumn,value:identity});
  return context;
}

export function bindMatterIdentityDetailTemplate({envelope, definition, context}) {
  const binding=parameterization(definition,"verified-search-identity");
  const identity=identities.get(context);
  if (!identity || context?.verified!==true || context.sourceTemplateId!==binding.sourceTemplateId ||
      identity.column.toLowerCase()!==binding.sourceColumn?.toLowerCase()) {
    throw new Error("MATTER_IDENTITY_CONTEXT_REJECTED");
  }
  const statement=verifyBase(envelope,definition);
  const compiled=binding.mode==="multi-scalar-equality"
    ?(binding.expectedOccurrenceCounts?bindManyRepeated(statement,binding,identity.value):bindMany(statement,binding.predicateColumns,identity.value))
    :bind(statement,binding.predicateColumn,identity.value,undefined,{allowNumber:binding.mode==="single-scalar-equality"});
  return compiledEnvelope(envelope,compiled);
}

// Trusted integration helper for a scalar that was derived from a previously
// verified server response. Public/MCP boundaries must never pass `value`
// directly; they call a higher-level lookup that derives it in memory.
export function bindTrustedDerivedScalarTemplate({envelope,definition,value}){
  const binding=parameterization(definition,"trusted-derived-identity");
  if(!["single-scalar-equality","scalar-equality-as-literal"].includes(binding.mode)||binding.sourceColumn!==undefined||binding.sourceTemplateId!==undefined){
    throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
  }
  const statement=verifyBase(envelope,definition);
  const compiled=binding.mode==="scalar-equality-as-literal"?bindAsLiteral(statement,binding.predicateColumn,value):bind(statement,binding.predicateColumn,value,undefined,{allowNumber:true});
  return compiledEnvelope(envelope,compiled);
}
