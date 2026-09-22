import {createEasyPatRuntime} from "./runtime.mjs";
import {normalizeExactApplicationNumber} from "./protocol/application-number.mjs";

const TARGETS=Object.freeze(["P261048","P261315"]);
const EXPECTED_ITEM_KEYS=Object.freeze(["applicationNumber","matterReference","rightType","status","titleKorean"]);
let failureStage="initialize";
let inputDiagnostic=null;
let productionEnabled=false;

function diagnostic(value){
  if(typeof value!=="string")return{type:typeof value,isNull:value===null};
  const trimmed=value.trim();
  return{
    type:"string",
    length:value.length,
    trimmedLength:trimmed.length,
    outerWhitespace:value!==trimmed,
    asciiOnly:/^[\x20-\x7e]*$/.test(value),
    containsInternalWhitespace:/\s/.test(trimmed),
    characterPattern:[...trimmed].map(character=>/[0-9]/.test(character)?"D":/[A-Za-z]/.test(character)?"A":/[./()-]/.test(character)?character:"?").join(""),
  };
}

async function main(){
  const runtime=createEasyPatRuntime({applicationNumberSearchValidation:true});
  productionEnabled=runtime.status().genericApplicationNumberSearchEnabled===true;
  const validations=[];
  for(const matterReference of TARGETS){
    failureStage=`summary-${matterReference}`;
    const summary=await runtime.getMatterSummary({matterReference});
    failureStage=`normalize-${matterReference}`;
    inputDiagnostic=diagnostic(summary.applicationNumber);
    const applicationNumber=normalizeExactApplicationNumber(summary.applicationNumber);
    inputDiagnostic=null;
    failureStage=`application-search-${matterReference}`;
    const result=await runtime.validateApplicationNumberSearch({applicationNumber});
    failureStage=`verify-${matterReference}`;
    const exactMatterMatches=result.items.filter(item=>item.matterReference===matterReference&&item.applicationNumber===applicationNumber);
    if(result.applicationNumber!==applicationNumber||result.count!==result.items.length||exactMatterMatches.length!==1||
       result.items.some(item=>Object.keys(item).sort().join(",")!==EXPECTED_ITEM_KEYS.join(","))||
       /idx|applicant|cookie|sql|password/i.test(JSON.stringify(result)))throw new Error("LIVE_APPLICATION_NUMBER_VALIDATION_REJECTED");
    validations.push(Object.freeze({matterReference,exactMatterMatchCount:1,candidateProjectionSafe:true}));
  }
  process.stdout.write(JSON.stringify({
    status:"live-application-number-search-validated",
    validatedMatterReferences:validations.map(item=>item.matterReference),
    validationCount:validations.length,
    exactApplicationNumberMatchRequired:true,
    safeProjectionFieldCount:5,
    rawRowsReturned:false,
    internalIdentityReturned:false,
    automaticRetryPerformed:false,
    serverMutationPerformed:false,
    productionEnabled,
    mcpExposureEnabled:productionEnabled,
  })+"\n");
}

main().catch(()=>{
  process.stdout.write(JSON.stringify({status:"live-application-number-search-validation-failed",failureStage,inputDiagnostic,rawValuesReturned:false,automaticRetryPerformed:false,serverMutationPerformed:false,productionEnabled,mcpExposureEnabled:productionEnabled})+"\n");
  process.exitCode=1;
});
