const matterPattern=/\b(?:PPT|PT|P|T)\d{6}(?:-[A-Z0-9()]+)?\b/giu;
const amountPattern=/\b\d{1,4}(?:[,+-]\d{1,4})+(?:\*\d+)?\b/gu;
const keywordVocabulary=["수임","위임","특허","상표","견적","출원","등록","메이킹","우선심사","당소관리번호","변리사","직무","성과","연구전담부서"];

export function extractTextFacts(text){
  if(typeof text!=="string"||text.length>100000)throw new Error("OCR_TEXT_REJECTED");
  const normalized=text.normalize("NFKC").replace(/\r\n?/g,"\n");
  const amountNormalized=normalized.replace(/(?<=\d)\s*([+-])\s*(?=\d)/gu,"$1").replace(/(?<=[+-]\d)\s+(?=\d{1,2}\b)/gu,"");
  const unique=values=>[...new Set(values)];
  const matterReferences=unique(normalized.match(matterPattern)??[]).map(value=>value.toUpperCase());
  const amountExpressions=unique(amountNormalized.match(amountPattern)??[]);
  const keywordHits=keywordVocabulary.filter(keyword=>normalized.includes(keyword));
  const maskedTokenCount=(normalized.match(/[xX＊*]{3,}/g)??[]).length;
  return Object.freeze({matterReferences,amountExpressions,keywordHits,maskedTokenCount,lineCount:normalized?normalized.split("\n").length:0});
}
