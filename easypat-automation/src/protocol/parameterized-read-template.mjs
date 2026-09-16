import { credentialColumns } from "./response-schema.mjs";
import { createReadOnlyBatch } from "./read-only-guard.mjs";
import { fingerprintEnvelope } from "./template-fingerprint.mjs";
import { normalizeExactMatterReference } from "./matter-reference.mjs";

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
  const allowedModes=source==="matter-reference"?["single-literal-equality","repeated-like-contains"]:["single-literal-equality","single-scalar-equality"];
  if (!binding || !allowedModes.includes(binding.mode) || binding.source !== source ||
      !NAME.test(binding.predicateColumn ?? "")) throw new Error("PARAMETERIZED_DEFINITION_REJECTED");
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
    if(terminates)matches.push({index:i+1,token:right});
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

export function createMatterIdentityContext({matterReference, searchResult, definition}) {
  const matter=normalizeExactMatterReference(matterReference);
  if (!definition || !TEMPLATE_ID.test(definition.templateId??"") || !NAME.test(definition.responseMatterColumn??"") ||
      !NAME.test(definition.responseIdentityColumn??"") || searchResult?.templateId!==definition.templateId ||
      !Array.isArray(searchResult.columns) || !Array.isArray(searchResult.rows) || searchResult.rows.length!==1 ||
      credentialColumns(searchResult.columns).length) throw new Error("SEARCH_IDENTITY_REJECTED");
  if (Array.isArray(definition.expectedResponseColumns) &&
      (definition.expectedResponseColumns.length!==searchResult.columns.length ||
       definition.expectedResponseColumns.some((column,index)=>column!==searchResult.columns[index]))) {
    throw new Error("SEARCH_IDENTITY_REJECTED");
  }
  const column=(name)=>searchResult.columns.filter(item=>item.toLowerCase()===name.toLowerCase());
  const matterColumns=column(definition.responseMatterColumn), identityColumns=column(definition.responseIdentityColumn);
  if (matterColumns.length!==1 || identityColumns.length!==1) throw new Error("SEARCH_IDENTITY_REJECTED");
  const row=searchResult.rows[0], identity=row[identityColumns[0]];
  if (row[matterColumns[0]]!==matter || typeof identity!=="string" || !identity.length || identity.length>1024 ||
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
  return compiledEnvelope(envelope,bind(statement,binding.predicateColumn,identity.value,undefined,{allowNumber:binding.mode==="single-scalar-equality"}));
}
