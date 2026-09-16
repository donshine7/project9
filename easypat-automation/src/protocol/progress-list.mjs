const FIELDS = Object.freeze({
  sequence: "no_rec",
  recordDate: "d_rec",
  noticeDate: "d_noti",
  document: "rec_doc",
  division: "rec_div",
  description: "rec_memo",
  briefDueDate: "d_brief_due",
  opinionDueDate: "d_opinion_due",
  processDate: "d_proc",
  dueDate: "d_due",
  assignee: "clerk",
  department: "part",
  method: "method"
});

function safeValue(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 4096 || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw new Error("PROGRESS_LIST_VALUE_REJECTED");
  }
  return value;
}

export function projectProgressList(result) {
  let matterReference;
  try { matterReference=normalizeExactMatterReference(result?.matterReference); }
  catch { throw new Error("PROGRESS_LIST_SOURCE_REJECTED"); }
  if (!result || result.matterReference !== matterReference || result.templateId !== "matter-detail.progress-records.v1" ||
      !Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length < 1 || result.rows.length > 500) {
    throw new Error("PROGRESS_LIST_SOURCE_REJECTED");
  }
  const items=result.rows.map(row=>{
    const item={};
    for(const [output,column] of Object.entries(FIELDS)){
      if(!result.columns.includes(column)||!Object.hasOwn(row,column))throw new Error("PROGRESS_LIST_SCHEMA_REJECTED");
      item[output]=safeValue(row[column]);
    }
    return Object.freeze(item);
  });
  return Object.freeze({matterReference,count:items.length,items:Object.freeze(items)});
}

export const progressListFields=Object.freeze({...FIELDS});
import { normalizeExactMatterReference } from "./matter-reference.mjs";
