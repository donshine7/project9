const MAX_BYTES=2*1024*1024;
export const AUTH_RESPONSE_COLUMNS=Object.freeze([
  Object.freeze(["idx","kipris","company","comno","owner","addr","zipno","uptae","jongmok","ck_bib","ck_hdr","ck_etax","ck_print","ck_annual","ck_off_fee","ck_outsourcing","ck_applicant","ck_email","del_flag","d_update","ck_approve","dd"]),
  Object.freeze(["idx","code","div_use","id","pw","name","name_eng","name_cn","name_ini","depart","jikck","power_result","power_attendance","power_schedule","d_enter","d_retire","ck_off","d_birth","ck_birth","n_annual","tel","tel_etc","ip_tel","cell","email","ck_marry","religion","hobby","ability","memo","add1","add2","zipcode","user_path","power_grade","sort","get_mail_approve","approve_ok","ck_burg","time_delay","del_flag","mobile_refresh_token","macad","pcname"]),
  Object.freeze(["urightcode","uright","_uread","_uwrite","_udelete","_uprint","_uattach"]),
  Object.freeze(["today"]),Object.freeze(["nowtime"]),
]);
const SELECTED=Object.freeze([[],["id"],["urightcode","_uread","_uwrite","_udelete","_uprint","_uattach"],["today"],["nowtime"]]);
function splitParts({text,contentType,framing}){
  if(typeof text!=="string"||Buffer.byteLength(text)>MAX_BYTES||!["rfc2046","observed-jbori"].includes(framing))throw new Error();
  const m=/^multipart\/mixed\s*;\s*boundary=(?:"([-A-Za-z0-9]{1,70})"|([-A-Za-z0-9]{1,70}))(?:\s*;\s*charset=UTF-8)?\s*$/i.exec(contentType);
  if(!m)throw new Error();
  const boundary=m[1]??m[2],delimiter=framing==="rfc2046"?"--"+boundary:boundary;
  if(!text.startsWith(delimiter+"\r\n"))throw new Error();
  const segments=text.split("\r\n"+delimiter);
  if(segments.length!==6||!/^--(?:\r\n)?$/.test(segments[5]))throw new Error();
  return segments.slice(0,5).map((segment,index)=>{
    const part=index===0?segment.slice(delimiter.length+2):segment.slice(2);
    if(index>0&&!segment.startsWith("\r\n"))throw new Error();
    const pos=part.indexOf("\r\n\r\n");
    if(pos<0||pos>4096||!/^Content-Type:\s*text\/resultset\s*$/i.test(part.slice(0,pos)))throw new Error();
    return part.slice(pos+4);
  });
}
function projectResultset(text,expected,selected){
  const records=[];let fields=[],value="",quoted=false,afterQuote=false,cellQuoted=false;
  const keep=new Map(selected.map(name=>[expected.indexOf(name),name]));
  if([...keep.keys()].some(i=>i<0))throw new Error();
  const retaining=()=>records.length<4||keep.has(fields.length);
  const pushCell=()=>{fields.push({value:retaining()?value:null,quoted:cellQuoted});value="";cellQuoted=false;afterQuote=false;};
  const pushRecord=()=>{pushCell();records.push(fields);fields=[];};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){if(c==='"'&&text[i+1]==='"'){if(retaining())value+='"';i++;}else if(c==='"'){quoted=false;afterQuote=true;}else if(retaining())value+=c;continue;}
    if(c==='"'&&!afterQuote){if(value!=="")throw new Error();quoted=true;cellQuoted=true;continue;}
    if(c==="\x01"){pushCell();continue;}
    if(c==="\r"&&text[i+1]==="\n"){pushRecord();i++;continue;}
    if(c==="\n"){pushRecord();continue;}
    if(afterQuote||c==='"'||c==="\r")throw new Error();
    if(retaining())value+=c;
  }
  if(quoted)throw new Error();
  if(value||fields.length||cellQuoted)pushRecord();
  if(records.length<4||records.some(r=>r.length!==expected.length))throw new Error();
  const names=records[0].map(c=>c.value);
  if(names.some((name,i)=>name!==expected[i]))throw new Error();
  if(records[1].some(c=>!/^(bigint|int|char|varchar|nvarchar|decimal|numeric|float|double|date|datetime|timestamp|bit|binary)$/i.test(c.value)))throw new Error();
  if(records[2].some(c=>!/^\d+$/.test(c.value)))throw new Error();
  if(records[3].some(c=>/[\r\n"\x00]/.test(c.value)))throw new Error();
  return records.slice(4).map(record=>Object.fromEntries([...keep].map(([i,name])=>[name,!record[i].quoted&&record[i].value==="null"?null:record[i].value])));
}
const RIGHT_KEYS=Object.freeze(["_uread","_uwrite","_udelete","_uprint","_uattach"]);
export function projectAuthenticationResponse(input,{rightsConventions}={}){
  try{
    const conventions=rightsConventions??Object.fromEntries(RIGHT_KEYS.map(key=>[key,{trueValue:"1",falseValue:"0"}]));
    if(Object.keys(conventions).sort().join(",")!==[...RIGHT_KEYS].sort().join(",")||Object.values(conventions).some(c=>typeof c?.trueValue!=="string"||typeof c?.falseValue!=="string"||c.trueValue===c.falseValue||c.trueValue.length>32||c.falseValue.length>32))throw new Error();
    const rows=projectParts(input);
    if(rows[0].length!==1||rows[1].length>1||rows[3].length!==1||rows[4].length!==1)throw new Error();
    const rights=rows[2].map(r=>{
      if(typeof r.urightcode!=="string"||!r.urightcode||r.urightcode.length>128)throw new Error();
      const flags={};for(const key of RIGHT_KEYS){const c=conventions[key];if(![c.trueValue,c.falseValue].includes(r[key]))throw new Error();flags[key]=r[key]===c.trueValue;}
      return {code:r.urightcode,...flags};
    });
    const ids=rows[1].map(r=>r.id);
    if(ids.some(id=>typeof id!=="string"||!id||id.length>128))throw new Error();
    return {identityIds:ids,rights,companySettingsRowCount:1,serverClockPresent:true,sensitiveColumnsReturned:false};
  }catch{throw new Error("AUTH_RESPONSE_REJECTED");}
}

function projectParts(input){
  const parts=splitParts(input);
  return parts.map((part,i)=>projectResultset(part,AUTH_RESPONSE_COLUMNS[i],SELECTED[i]));
}

export function inspectAuthenticationResponseShape(input){
  try{
    const rows=projectParts(input),rights=rows[2];
    const flags=rights.flatMap(r=>[r._uread,r._uwrite,r._udelete,r._uprint,r._uattach]);
    return {status:"response-shape-inspected",rowCounts:rows.map(r=>r.length),identityValuesPresent:rows[1].every(r=>typeof r.id==="string"&&r.id.length>0),rightsCodesPresent:rights.every(r=>typeof r.urightcode==="string"&&r.urightcode.length>0),rightsFlagsAllBinary:flags.every(v=>/^[01]$/.test(v)),rightsFlagsAllYN:flags.every(v=>/^[YN]$/i.test(v)),sensitiveValuesIncluded:false,executable:false};
  }catch{throw new Error("AUTH_RESPONSE_SHAPE_REJECTED");}
}
