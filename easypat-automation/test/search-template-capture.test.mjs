import test from "node:test";
import assert from "node:assert/strict";
import { inspectCapturedSearchForms, summarizeCapturedSearchForms } from "../src/protocol/search-template-capture.mjs";

function query({count=false,reference="P261793",occurrences=4}={}){
  const branches=[];
  for(let i=0;i<occurrences;i++)branches.push(`SELECT idx, ourref FROM table_${i} WHERE del_flag = 'N' AND ourref LIKE '%${reference}%'`);
  const rows=branches.join(" UNION ALL ");
  return count?`SELECT count(*) AS 'recCount' from (${rows}) tb`:rows;
}
function form(sql){return new URLSearchParams({connection:"EASYPAT_S_SSPAT",count:"1",command:"SELECT",sql}).toString();}
function fixture(overrides={}){return {countBody:form(query({count:true})),resultBody:form(query()),...overrides};}

test("inspects the two captured search roles without returning statements",()=>{
  const items=inspectCapturedSearchForms(fixture()),summary=summarizeCapturedSearchForms(items);
  assert.deepEqual(summary.templates.map(item=>item.sessionId),[117,119]);
  assert.ok(summary.templates.every(item=>/^[a-f0-9]{64}$/.test(item.fingerprint)));
  assert.equal(summary.rawStatementsReturned,false);
  assert.doesNotMatch(JSON.stringify(summary),/SELECT|P261793|table_/i);
});

test("rejects changed form controls, role shapes, occurrence counts, and inconsistent references",()=>{
  const changedCommand=new URLSearchParams(fixture().countBody);changedCommand.set("command","UPDATE");
  for(const input of [
    fixture({countBody:changedCommand.toString()}),
    fixture({countBody:form(query())}),
    fixture({resultBody:form(query({count:true}))}),
    fixture({resultBody:form(query({occurrences:3}))}),
    fixture({resultBody:form(query({reference:"P261793-S1"}))}),
  ])assert.throws(()=>inspectCapturedSearchForms(input),/SEARCH_CAPTURE_REJECTED|SLOT_REJECTED/);
});
