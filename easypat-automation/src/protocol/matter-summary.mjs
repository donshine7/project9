import { normalizeExactMatterReference } from "./matter-reference.mjs";

const FIELDS = Object.freeze({
  rightType:"app_right",
  applicationKind:"app_kind",
  applicationDivision:"app_div",
  applicationDate:"d_app",
  applicationNumber:"n_app",
  titleKorean:"title_kor",
  status:"status",
});

function safeValue(value) {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048 || /[\p{Cc}\p{Cs}]/u.test(value)) {
    throw new Error("MATTER_SUMMARY_VALUE_REJECTED");
  }
  return value;
}

export function projectMatterSummary(result) {
  let matter;
  try { matter=normalizeExactMatterReference(result?.matterReference); }
  catch { throw new Error("MATTER_SUMMARY_SOURCE_REJECTED"); }
  if (!result || result.matterReference !== matter || result.templateId !== "matter-detail.main-record.v1" ||
      !Array.isArray(result.columns) || !Array.isArray(result.rows) || result.rows.length !== 1) {
    throw new Error("MATTER_SUMMARY_SOURCE_REJECTED");
  }
  const row=result.rows[0],summary={matterReference:matter};
  for (const [output,column] of Object.entries(FIELDS)) {
    if (!result.columns.includes(column) || !Object.hasOwn(row,column)) throw new Error("MATTER_SUMMARY_SCHEMA_REJECTED");
    summary[output]=safeValue(row[column]);
  }
  return Object.freeze(summary);
}

export const matterSummaryFields = Object.freeze({...FIELDS});
