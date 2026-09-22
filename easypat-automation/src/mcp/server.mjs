import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {z} from "zod/v4";
import {createEasyPatRuntime} from "../runtime.mjs";

const genericMatterReference=z.string().max(64).regex(/^(PPT|PT|P|T|D)\d{3,12}(?:-[A-Z0-9]+(?:\([A-Z0-9]+\))?)*$/).describe("조회할 전체 당소관리번호; 접미사를 생략하지 않음");
const applicationNumber=z.string().min(3).max(64).regex(/^[A-Za-z0-9](?:[A-Za-z0-9./()-]{1,62}[A-Za-z0-9])$/).describe("검색할 출원번호 전체 문자열; 하이픈·슬래시 등 표기를 유지함");
const nullableText=z.string().nullable();
const applicationSearchItem=z.object({matterReference:genericMatterReference,applicationNumber:z.string(),rightType:nullableText,titleKorean:nullableText,status:nullableText});
const progressItem=z.object({sequence:nullableText,recordDate:nullableText,noticeDate:nullableText,document:nullableText,division:nullableText,description:nullableText,briefDueDate:nullableText,opinionDueDate:nullableText,processDate:nullableText,dueDate:nullableText,assignee:nullableText,department:nullableText,method:nullableText});
const documentItem=z.object({position:z.number().int().positive(),documentName:nullableText,registeredAt:nullableText,fileName:z.string(),fileSizeBytes:z.number().int().nonnegative()});
const progressDocument=z.string().min(1).max(512).describe("진행상황에 표시되는 문서 항목명과 정확히 일치하는 값");
const noticeProgressDocument=z.enum(["의견제출통지서","거절결정서"]);
const isoDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const safePdfFileName=z.string().max(260).regex(/^[^\\/:*?"<>|\x00-\x1f]+\.pdf$/i);
const extractedFields=z.object({applicationType:nullableText,applicant:nullableText,inventorInstruction:nullableText,practitioner:nullableText,assignee:nullableText,databaseManager:nullableText,introducer:nullableText,fee:nullableText,estimateAndPowerOfAttorney:nullableText,note:nullableText});

const success=payload=>({content:[{type:"text",text:JSON.stringify(payload)}],structuredContent:payload});
const failure=()=>({content:[{type:"text",text:JSON.stringify({status:"error",code:"EASYPAT_OPERATION_FAILED"})}],isError:true});
const guarded=callback=>async input=>{try{return success(await callback(input));}catch{return failure();}};

export function createEasyPatMcpServer({runtime=createEasyPatRuntime()}={}){
  const server=new McpServer({name:"easypat-tools",version:"0.2.0"},{capabilities:{tools:{}}});
  server.registerTool("easypat_status",{
    title:"EasyPAT 자동화 상태",
    description:"서버 요청 없이 자동 로그인 준비 상태, 고정 템플릿 수, 허용된 작업을 반환합니다. 자격 증명과 세션 값은 반환하지 않습니다.",
    inputSchema:{},
    outputSchema:{status:z.literal("ready"),automaticAuthenticationReady:z.boolean(),sessionRefreshEnabled:z.literal(false),enabledTemplateCount:z.number().int(),genericMatterSummaryEnabled:z.boolean(),genericApplicationNumberSearchEnabled:z.boolean(),genericProgressListingEnabled:z.boolean(),genericDocumentListingEnabled:z.boolean(),genericProgressDocumentListingEnabled:z.boolean(),genericNoticeAttachmentListingEnabled:z.boolean(),genericProgressDocumentDownloadEnabled:z.boolean(),genericProgressDocumentExtractionEnabled:z.boolean(),domesticReportUploadPreviewImplemented:z.boolean(),domesticReportUploadCommitEnabled:z.boolean(),domesticReportUploadProtocolEvidenceComplete:z.boolean(),documentMatterBindingVerified:z.boolean(),allowedOperations:z.array(z.string())},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(async()=>{const value=runtime.status();return{status:"ready",automaticAuthenticationReady:value.automaticAuthenticationReady,sessionRefreshEnabled:false,enabledTemplateCount:value.enabledTemplateCount,genericMatterSummaryEnabled:value.genericMatterSummaryEnabled===true,genericApplicationNumberSearchEnabled:value.genericApplicationNumberSearchEnabled===true,genericProgressListingEnabled:value.genericProgressListingEnabled===true,genericDocumentListingEnabled:value.genericDocumentListingEnabled===true,genericProgressDocumentListingEnabled:value.genericProgressDocumentListingEnabled===true,genericNoticeAttachmentListingEnabled:value.genericNoticeAttachmentListingEnabled===true,genericProgressDocumentDownloadEnabled:value.genericProgressDocumentDownloadEnabled===true,genericProgressDocumentExtractionEnabled:value.genericProgressDocumentExtractionEnabled===true,domesticReportUploadPreviewImplemented:value.domesticReportUploadPreviewImplemented===true,domesticReportUploadCommitEnabled:value.domesticReportUploadCommitEnabled===true,domesticReportUploadProtocolEvidenceComplete:value.domesticReportUploadProtocolEvidenceComplete===true,documentMatterBindingVerified:value.documentMatterBindingVerified===true,allowedOperations:value.allowedOperations};}));

  server.registerTool("easypat_get_matter_summary",{
    title:"EasyPAT 사건 요약 조회",
    description:"자동 로그인 후 전체 당소관리번호를 정확히 검색하고 검증된 내부 연결로 사건의 허용된 7개 업무 필드만 조회합니다. SQL·URL·쿠키·내부키는 입력받지 않습니다.",
    inputSchema:{matterReference:genericMatterReference},
    outputSchema:{matterReference:genericMatterReference,rightType:nullableText,applicationKind:nullableText,applicationDivision:nullableText,applicationDate:nullableText,applicationNumber:nullableText,titleKorean:nullableText,status:nullableText},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.getMatterSummary({matterReference:input.matterReference})));

  server.registerTool("easypat_search_by_application_number",{
    title:"EasyPAT 출원번호 검색",
    description:"자동 로그인 후 출원번호를 정확히 검색하여 일치하는 사건의 당소관리번호·출원번호·권리구분·한글명칭·상태만 반환합니다. SQL·URL·쿠키·내부키는 입력받거나 반환하지 않습니다.",
    inputSchema:{applicationNumber},
    outputSchema:{applicationNumber:z.string(),count:z.number().int().nonnegative(),items:z.array(applicationSearchItem)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.searchByApplicationNumber({applicationNumber:input.applicationNumber})));

  server.registerTool("easypat_list_progress",{
    title:"EasyPAT 사건별 진행기록 조회",
    description:"전체 당소관리번호를 정확히 검색한 뒤 서버가 반환한 사건 식별값으로 진행기록의 허용된 13개 업무 필드만 조회합니다.",
    inputSchema:{matterReference:genericMatterReference},
    outputSchema:{matterReference:genericMatterReference,count:z.number().int().nonnegative(),items:z.array(progressItem)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.listProgress({matterReference:input.matterReference})));

  server.registerTool("easypat_list_documents",{
    title:"EasyPAT 사건별 문서 목록 조회",
    description:"전체 당소관리번호를 정확히 검색한 뒤 서버가 반환한 사건 식별값으로 문서 목록을 조회합니다. 공유 문서 그룹, 서버 업로드 경로와 내부키는 반환하지 않습니다.",
    inputSchema:{matterReference:genericMatterReference},
    outputSchema:{matterReference:genericMatterReference,count:z.number().int().nonnegative(),items:z.array(documentItem)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.listDocuments({matterReference:input.matterReference})));

  server.registerTool("easypat_list_progress_documents",{
    title:"EasyPAT 진행항목 첨부 목록 조회",
    description:"전체 당소관리번호와 진행항목명을 정확히 검증한 뒤 해당 항목의 첨부파일 목록만 반환합니다. SQL·내부키·서버 업로드 경로는 입력받거나 반환하지 않습니다.",
    inputSchema:{matterReference:genericMatterReference,progressDocument},
    outputSchema:{matterReference:genericMatterReference,progressDocument:z.string(),count:z.number().int().nonnegative(),items:z.array(documentItem)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.listProgressDocuments({matterReference:input.matterReference,progressDocument:input.progressDocument})));

  server.registerTool("easypat_list_notice_attachments",{
    title:"EasyPAT 통지 첨부 묶음 조회",
    description:"전체 당소관리번호와 의견제출통지서 또는 거절결정서 진행행을 검증하고 사건 첨부 저장소에서 해당 통지의 HDR ZIP·통지서·인용문헌·특허청 파일 묶음만 반환합니다. 동일 이름 진행행이 여러 개면 통지일 또는 진행번호를 함께 지정합니다.",
    inputSchema:{matterReference:genericMatterReference,progressDocument:noticeProgressDocument,noticeDate:isoDate.optional(),sequence:z.string().min(1).max(128).optional()},
    outputSchema:{matterReference:genericMatterReference,noticeKind:z.enum(["opinion_submission","rejection_decision"]),progressDocument:noticeProgressDocument,noticeDate:nullableText,dueDate:nullableText,sequence:nullableText,aggregateAttachmentCount:z.number().int().nonnegative(),count:z.number().int().positive(),items:z.array(documentItem)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.listNoticeAttachments(input)));

  server.registerTool("easypat_download_progress_document",{
    title:"EasyPAT 진행항목 첨부 다운로드",
    description:"최신 첨부 목록을 다시 검증한 뒤 선택한 파일을 같은 EasyPAT 서버에서 로컬 사건 폴더로 다운로드합니다. 기존 파일을 덮어쓰지 않으며 서버 경로는 반환하지 않습니다.",
    inputSchema:{matterReference:genericMatterReference,progressDocument,position:z.number().int().positive().max(500),expectedFileName:z.string().min(1).max(260)},
    outputSchema:{matterReference:genericMatterReference,position:z.number().int().positive(),fileName:z.string(),fileSizeBytes:z.number().int().nonnegative(),contentType:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),path:z.string(),downloaded:z.literal(true),alreadyPresent:z.literal(false),overwritten:z.literal(false),automaticRetryPerformed:z.literal(false),serverMutationPerformed:z.literal(false),serverUploadPathReturned:z.literal(false)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:false},
  },guarded(input=>runtime.downloadProgressDocument(input)));

  server.registerTool("easypat_extract_progress_document_pdf",{
    title:"EasyPAT 다운로드 PDF 정보 추출",
    description:"로컬 사건 폴더에 다운로드된 수임내역서 PDF에서 허용된 업무 표 필드만 추출합니다. 이메일·전화번호·주소와 전체 원문은 반환하지 않습니다.",
    inputSchema:{matterReference:genericMatterReference,fileName:safePdfFileName},
    outputSchema:{matterReference:genericMatterReference,sourceFileName:z.string(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),pageCount:z.number().int().positive(),fields:extractedFields,requestedMatterCount:z.number().int().positive().nullable(),requestedMatterPrefix:z.enum(["PPT","PT","P","T","D"]).nullable(),relatedMatterReferences:z.array(genericMatterReference),rawTextReturned:z.literal(false),emailAddressesReturned:z.literal(false),contactDetailsReturned:z.literal(false),externalUploadPerformed:z.literal(false)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  },guarded(input=>runtime.extractProgressDocumentPdf(input)));

  return server;
}
