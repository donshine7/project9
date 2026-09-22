import {credentialColumns} from "./response-schema.mjs";
import {normalizeExactApplicationNumber} from "./application-number.mjs";
import {normalizeExactMatterReference} from "./matter-reference.mjs";
import {bindApplicationNumberSearchTemplate} from "./parameterized-read-template.mjs";

export class ApplicationNumberSearchError extends Error{
  constructor(code){super(code);this.name="ApplicationNumberSearchError";this.code=code;}
}

function exactSchema(result,expected){
  return Array.isArray(expected)&&expected.length>0&&Array.isArray(result?.columns)&&
    expected.length===result.columns.length&&expected.every((column,index)=>column===result.columns[index]);
}

function candidateCount(result,definition,maximum){
  if(!result||result.templateId!==definition.templateId||!exactSchema(result,definition.expectedResponseColumns)||
     !Array.isArray(result.rows)||result.rows.length!==1||credentialColumns(result.columns).length||
     !Number.isSafeInteger(maximum)||maximum<1||maximum>5000)throw new Error("APPLICATION_SEARCH_COUNT_REJECTED");
  const matches=result.columns.filter(column=>column.toLowerCase()===definition.responseCountColumn?.toLowerCase());
  const value=matches.length===1?result.rows[0]?.[matches[0]]:undefined;
  if(typeof value!=="string"||!/^(?:0|[1-9]\d*)$/.test(value))throw new Error("APPLICATION_SEARCH_COUNT_REJECTED");
  const count=Number(value);
  if(!Number.isSafeInteger(count)||count<0||count>maximum)throw new Error("APPLICATION_SEARCH_COUNT_REJECTED");
  return count;
}

function safeText(value){
  if(value===null||value==="")return null;
  if(typeof value!=="string"||value.length>2048||/[\p{Cc}\p{Cs}]/u.test(value))throw new Error("APPLICATION_SEARCH_VALUE_REJECTED");
  return value;
}

function projectExactRows({applicationNumber,result,definition,derivation}){
  if(!result||result.templateId!==definition.templateId||!exactSchema(result,definition.expectedResponseColumns)||
     !Array.isArray(result.rows)||credentialColumns(result.columns).length)throw new Error("APPLICATION_SEARCH_RESULT_REJECTED");
  const required=[definition.responseMatterColumn,derivation.responseApplicationNumberColumn,"app_right","title_kor","status"];
  if(required.some(name=>typeof name!=="string"||result.columns.filter(column=>column.toLowerCase()===name.toLowerCase()).length!==1)){
    throw new Error("APPLICATION_SEARCH_RESULT_REJECTED");
  }
  const column=name=>result.columns.find(item=>item.toLowerCase()===name.toLowerCase());
  const exact=[];
  for(const row of result.rows){
    let candidate;
    try{candidate=normalizeExactApplicationNumber(row?.[column(derivation.responseApplicationNumberColumn)]);}
    catch{throw new Error("APPLICATION_SEARCH_RESULT_REJECTED");}
    if(candidate!==applicationNumber)continue;
    let matterReference;
    try{matterReference=normalizeExactMatterReference(row?.[column(definition.responseMatterColumn)]);}
    catch{throw new Error("APPLICATION_SEARCH_RESULT_REJECTED");}
    exact.push(Object.freeze({
      matterReference,
      applicationNumber:candidate,
      rightType:safeText(row?.[column("app_right")]),
      titleKorean:safeText(row?.[column("title_kor")]),
      status:safeText(row?.[column("status")]),
    }));
  }
  return Object.freeze(exact);
}

// Offline orchestration. Providers are trusted local adapters; the caller can
// supply only an application number, never SQL, endpoint, cookies or retries.
export function createApplicationNumberSearch({countDefinition,searchDefinition,derivation,loadTemplate,executeRead}){
  const count=structuredClone(countDefinition),search=structuredClone(searchDefinition),fixed=structuredClone(derivation);
  if(typeof loadTemplate!=="function"||typeof executeRead!=="function"||
     fixed?.sourcePredicateColumn!=="ourref"||fixed?.targetPredicateColumn!=="n_app"||
     fixed?.responseApplicationNumberColumn!=="n_app"||
     !Number.isSafeInteger(fixed?.maximumSearchCandidateCount)||fixed.maximumSearchCandidateCount!==500){
    throw new Error("APPLICATION_SEARCH_PROVIDER_REJECTED");
  }
  return Object.freeze({
    async search(input){
      if(!input||Object.keys(input).sort().join(",")!=="applicationNumber")throw new ApplicationNumberSearchError("APPLICATION_SEARCH_INPUT_REJECTED");
      let applicationNumber,countEnvelope,countResult,countValue,searchEnvelope,searchResult,items;
      try{applicationNumber=normalizeExactApplicationNumber(input.applicationNumber);}
      catch{throw new ApplicationNumberSearchError("APPLICATION_SEARCH_INPUT_REJECTED");}
      try{
        countEnvelope=bindApplicationNumberSearchTemplate({envelope:await loadTemplate(count.templateId),definition:count,applicationNumber,derivation:fixed});
        countResult=await executeRead({operation:"search-matter",role:"count-application-results",envelope:countEnvelope});
        countValue=candidateCount(countResult,count,fixed.maximumSearchCandidateCount);
        if(countValue===0)return Object.freeze({applicationNumber,count:0,items:Object.freeze([])});
        searchEnvelope=bindApplicationNumberSearchTemplate({envelope:await loadTemplate(search.templateId),definition:search,applicationNumber,derivation:fixed});
        searchResult=await executeRead({operation:"search-matter",role:"fetch-application-result-rows",envelope:searchEnvelope});
        if(!Array.isArray(searchResult?.rows)||searchResult.rows.length!==countValue)throw new Error("APPLICATION_SEARCH_RESULT_REJECTED");
        items=projectExactRows({applicationNumber,result:searchResult,definition:search,derivation:fixed});
        return Object.freeze({applicationNumber,count:items.length,items});
      }catch(error){
        if(error instanceof ApplicationNumberSearchError)throw error;
        throw new ApplicationNumberSearchError("APPLICATION_SEARCH_READ_REJECTED");
      }finally{countEnvelope=null;countResult=null;countValue=null;searchEnvelope=null;searchResult=null;items=null;}
    },
  });
}
