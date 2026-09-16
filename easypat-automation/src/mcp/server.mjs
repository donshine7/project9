import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod/v4";
import {createEasyPatRuntime} from "../runtime.mjs";
import {readP261793Extraction} from "../extraction/read-extraction.mjs";

const matterInput={matterReference:z.literal("P261793").describe("현재 검증된 전체 당소관리번호")};
const genericMatterReference=z.string().max(64).regex(/^(PPT|PT|P|T)\d{3,12}(?:-[A-Z0-9]+(?:\([A-Z0-9]+\))?)*$/).describe("조회할 전체 당소관리번호; 접미사를 생략하지 않음");
const nullableText=z.string().nullable();
const progressItem=z.object({sequence:nullableText,recordDate:nullableText,noticeDate:nullableText,document:nullableText,division:nullableText,description:nullableText,briefDueDate:nullableText,opinionDueDate:nullableText,processDate:nullableText,dueDate:nullableText,assignee:nullableText,department:nullableText,method:nullableText});
const documentItem=z.object({position:z.number().int().positive(),documentName:nullableText,registeredAt:nullableText,fileName:z.string(),fileSizeBytes:z.number().int().nonnegative()});

const success=payload=>({content:[{type:"text",text:JSON.stringify(payload)}],structuredContent:payload});
const failure=()=>({content:[{type:"text",text:JSON.stringify({status:"error",code:"EASYPAT_OPERATION_FAILED"})}],isError:true});
const guarded=callback=>async input=>{try{return success(await callback(input));}catch{return failure();}};

export function createEasyPatMcpServer({runtime=createEasyPatRuntime(),readExtraction=readP261793Extraction}={}){
  const server=new McpServer({name:"easypat-fixed-tools",version:"0.1.0"},{capabilities:{tools:{}}});
  server.registerTool("easypat_status",{
    title:"EasyPAT 자동화 상태",
    description:"서버 요청 없이 자동 로그인 준비 상태, 고정 템플릿 수, 허용된 작업을 반환합니다. 자격 증명과 세션 값은 반환하지 않습니다.",
    inputSchema:{},
    outputSchema:{status:z.literal("ready"),automaticAuthenticationReady:z.boolean(),sessionRefreshEnabled:z.literal(false),enabledTemplateCount:z.number().int(),genericMatterSummaryEnabled:z.boolean(),allowedOperations:z.array(z.string())},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(async()=>{const value=runtime.status();return{status:"ready",automaticAuthenticationReady:value.automaticAuthenticationReady,sessionRefreshEnabled:false,enabledTemplateCount:value.enabledTemplateCount,genericMatterSummaryEnabled:value.genericMatterSummaryEnabled===true,allowedOperations:value.allowedOperations};}));

  server.registerTool("easypat_get_matter_summary",{
    title:"EasyPAT 사건 요약 조회",
    description:"자동 로그인 후 전체 당소관리번호를 정확히 검색하고 검증된 내부 연결로 사건의 허용된 7개 업무 필드만 조회합니다. SQL·URL·쿠키·내부키는 입력받지 않습니다.",
    inputSchema:{matterReference:genericMatterReference},
    outputSchema:{matterReference:genericMatterReference,rightType:nullableText,applicationKind:nullableText,applicationDivision:nullableText,applicationDate:nullableText,applicationNumber:nullableText,titleKorean:nullableText,status:nullableText},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.getMatterSummary({matterReference:input.matterReference})));

  server.registerTool("easypat_list_progress",{
    title:"P261793 진행기록 조회",
    description:"자동 로그인 후 검증된 고정 SELECT로 P261793 진행기록의 허용된 13개 업무 필드만 조회합니다.",
    inputSchema:matterInput,
    outputSchema:{matterReference:z.literal("P261793"),count:z.number().int().nonnegative(),items:z.array(progressItem)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.listProgress({templateId:"matter-detail.progress-records.v1",matterReference:input.matterReference})));

  server.registerTool("easypat_list_documents",{
    title:"P261793 문서 목록 조회",
    description:"검증된 공유 문서 그룹의 문서 메타데이터만 반환합니다. 서버 업로드 경로와 내부키는 반환하지 않습니다.",
    inputSchema:matterInput,
    outputSchema:{matterReference:z.literal("P261793"),count:z.number().int().nonnegative(),items:z.array(documentItem)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.listDocuments({templateId:"matter-detail.documents.v1",matterReference:input.matterReference})));

  server.registerTool("easypat_download_document",{
    title:"검증된 수임내역서 JPEG 다운로드",
    description:"최신 문서 목록을 다시 검증한 뒤 허용된 목록 2번 JPEG 한 건만 다운로드합니다. 기존 파일은 덮어쓰지 않습니다.",
    inputSchema:{matterReference:z.literal("P261793"),position:z.literal(2),expectedFileName:z.literal("P261545외_수임내역서(수정).jpg")},
    outputSchema:{matterReference:z.literal("P261793"),position:z.literal(2),fileName:z.string(),fileSizeBytes:z.number().int().nonnegative(),contentType:z.literal("image/jpeg"),sha256:z.string().regex(/^[a-f0-9]{64}$/),path:z.string(),downloaded:z.boolean(),alreadyPresent:z.boolean(),overwritten:z.literal(false),automaticRetryPerformed:z.literal(false),serverMutationPerformed:z.literal(false),serverUploadPathReturned:z.literal(false)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.downloadDocument(input)));

  server.registerTool("easypat_get_document_extraction",{
    title:"수임내역서 JPEG 추출 정보 조회",
    description:"로컬 Windows OCR로 이미 검증된 JPEG에서 추출한 사건번호·금액 표현·업무 키워드만 반환합니다. OCR 원문은 반환하지 않습니다.",
    inputSchema:{matterReference:z.literal("P261793"),position:z.literal(2)},
    outputSchema:{matterContext:z.literal("P261793"),sourceFileName:z.string(),ocrEngine:z.literal("windows-media-ocr"),ocrLanguage:z.literal("ko-KR"),lineCount:z.number().int().nonnegative(),matterReferences:z.array(z.string()),amountExpressions:z.array(z.string()),keywordHits:z.array(z.string()),maskedTokenCount:z.number().int().nonnegative(),rawOcrTextReturned:z.literal(false),externalUploadPerformed:z.literal(false)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(async()=>readExtraction()));
  return server;
}
