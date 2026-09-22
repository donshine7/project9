import { readFileSync } from "node:fs";
import { createFixedReadClient } from "./protocol/fixed-read-client.mjs";
import { createAuthenticationTransport } from "./protocol/authentication-transport.mjs";
import { createTemplateStore } from "./security/template-store.mjs";
import { createAuthenticationTemplateStore } from "./security/authentication-template-store.mjs";
import { createVerifiedAuthenticationAdapter } from "./security/authentication-adapter.mjs";
import { createSessionProvider } from "./security/session-provider.mjs";
import { projectMatterSummary } from "./protocol/matter-summary.mjs";
import { projectProgressList } from "./protocol/progress-list.mjs";
import { projectDocumentList } from "./protocol/document-list.mjs";
import { createGenericMatterSummaryClient } from "./protocol/generic-matter-summary-client.mjs";
import { createGenericApplicationNumberSearchClient } from "./protocol/generic-application-number-search-client.mjs";
import { createGenericDocumentClient } from "./protocol/generic-document-client.mjs";
import { createGenericProgressClient } from "./protocol/generic-progress-client.mjs";
import { createGenericProgressDocumentClient } from "./protocol/generic-progress-document-client.mjs";
import { createGenericNoticeAttachmentClient } from "./protocol/generic-notice-attachment-client.mjs";
import { createGenericDocumentDownloader } from "./protocol/generic-document-downloader.mjs";
import { extractProgressDocumentPdf } from "./extraction/progress-document-pdf.mjs";
import { createNoticePackagePublisher } from "./workflow/notice-package-publisher.mjs";

// Called only by trusted local integration code. No user/LLM-supplied adapter.
export function createEasyPatRuntime({verifiedLoginAdapter,applicationNumberSearchValidation=false}={}){
  const readJson=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),"utf8"));
  const policy=readJson("../config/safety-policy.json");
  const registry=readJson("../config/read-template-registry.json");
  const genericRegistry=readJson("../config/generic-read-template-registry.json");
  const domesticReportUploadPolicy=readJson("../config/domestic-report-upload-policy.json");
  const mainSchema=readJson("../config/main-record-response-schema.json");
  const candidates=readJson("../config/protocol-observations/local-read-fingerprints.json").candidates;
  const knownTemplateIds=new Set(candidates.map(candidate=>candidate.templateId));
  for(const definition of genericRegistry.templates){if(!knownTemplateIds.has(definition.templateId))candidates.push({templateId:definition.templateId,command:definition.command,statementCount:definition.statementCount,fingerprint:definition.baseFingerprint,productionEnabled:false});}
  const authenticationTemplate=readJson("../config/authentication-template.json");
  const authenticationVerification=readJson("../config/protocol-observations/authentication-live-verification.json");
  const store=createTemplateStore({candidates});
  const adapter=verifiedLoginAdapter===undefined?createVerifiedAuthenticationAdapter({verification:authenticationVerification,templateStore:createAuthenticationTemplateStore({expectedFingerprint:authenticationTemplate.fingerprint}),expectedFingerprint:authenticationTemplate.fingerprint,transport:createAuthenticationTransport()}):verifiedLoginAdapter;
  const session=createSessionProvider({adapter});
  const client=createFixedReadClient({policy,registry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  const genericSummary=createGenericMatterSummaryClient({policy,registry:genericRegistry,mainSchema,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  const genericApplicationSearch=(policy.genericApplicationNumberSearchConstraints?.enabled===true||applicationNumberSearchValidation===true)
    ?createGenericApplicationNumberSearchClient({policy,registry:genericRegistry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie,validationOnly:applicationNumberSearchValidation===true})
    :null;
  const genericProgress=createGenericProgressClient({policy,registry:genericRegistry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  const genericDocuments=createGenericDocumentClient({policy,registry:genericRegistry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  const genericProgressDocuments=createGenericProgressDocumentClient({policy,registry:genericRegistry,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  const genericNoticeAttachments=createGenericNoticeAttachmentClient({policy,registry:genericRegistry,protocolCandidates:candidates,loadTemplate:store.load,getSessionCookie:session.getSessionCookie});
  const genericDownloader=createGenericDocumentDownloader({policy,prepareDownload:genericProgressDocuments.prepareDownload,getSessionCookie:session.getSessionCookie});
  const noticePackagePublisher=createNoticePackagePublisher({policy,preparePackage:genericNoticeAttachments.prepareNoticePackage,getSessionCookie:session.getSessionCookie});
  const documentMatterBindingVerified=policy.directReadConstraints?.["list-documents"]?.matterBindingVerified===true;
  const genericDocumentListingEnabled=genericDocuments.status.enabled&&policy.genericDocumentConstraints?.mcpExposureEnabled===true;
  const genericApplicationNumberSearchEnabled=genericApplicationSearch?.status.enabled===true&&policy.genericApplicationNumberSearchConstraints?.mcpExposureEnabled===true;
  const genericProgressListingEnabled=genericProgress.status.enabled&&policy.genericProgressConstraints?.mcpExposureEnabled===true;
  const genericProgressDocumentListingEnabled=genericProgressDocuments.status.enabled&&policy.genericProgressDocumentConstraints?.mcpExposureEnabled===true;
  const genericProgressDocumentDownloadEnabled=genericProgressDocumentListingEnabled&&policy.genericDownloadConstraints?.enabled===true&&policy.genericDownloadConstraints?.mcpExposureEnabled===true;
  const genericNoticeAttachmentListingEnabled=genericNoticeAttachments.status.enabled&&policy.genericNoticeAttachmentConstraints?.mcpExposureEnabled===true;
  const allowedOperations=policy.allowedOperations.filter(operation=>{
    if(operation==="list-documents")return genericDocumentListingEnabled||documentMatterBindingVerified;
    if(operation==="download-document")return genericProgressDocumentDownloadEnabled;
    return true;
  });
  return Object.freeze({
    read:client.read,
    async readMatterSummary(input){return projectMatterSummary(await client.read(input));},
    async getMatterSummary(input){
      if(policy.genericMatterSummaryConstraints?.mcpExposureEnabled!==true)throw new Error("GENERIC_MCP_DISABLED");
      return genericSummary.lookupSummary(input);
    },
    async searchByApplicationNumber(input){if(!genericApplicationNumberSearchEnabled)throw new Error("GENERIC_APPLICATION_NUMBER_SEARCH_DISABLED");return genericApplicationSearch.search(input);},
    async validateApplicationNumberSearch(input){if(applicationNumberSearchValidation!==true||genericApplicationSearch===null)throw new Error("APPLICATION_NUMBER_SEARCH_VALIDATION_DISABLED");return genericApplicationSearch.search(input);},
    async listProgress(input){if(genericProgressListingEnabled)return genericProgress.listProgress(input);return projectProgressList(await client.read(input));},
    async listDocuments(input){if(genericDocumentListingEnabled)return genericDocuments.listDocuments(input);if(!documentMatterBindingVerified)throw new Error("DOCUMENT_MATTER_BINDING_UNVERIFIED");return projectDocumentList(await client.read(input),{contextBinding:"captured-p261793-fixed-document-group"});},
    async listProgressDocuments(input){if(!genericProgressDocumentListingEnabled)throw new Error("GENERIC_PROGRESS_DOCUMENT_MCP_DISABLED");return genericProgressDocuments.listDocuments(input);},
    async listNoticeAttachments(input){if(!genericNoticeAttachmentListingEnabled)throw new Error("GENERIC_NOTICE_ATTACHMENT_MCP_DISABLED");return genericNoticeAttachments.listNoticeAttachments(input);},
    async downloadProgressDocument(input){if(!genericProgressDocumentDownloadEnabled)throw new Error("GENERIC_PROGRESS_DOCUMENT_DOWNLOAD_DISABLED");return genericDownloader.download(input);},
    async publishNoticePackage(input){if(!genericNoticeAttachmentListingEnabled||policy.noticePackageDownloadConstraints?.enabled!==true)throw new Error("NOTICE_PACKAGE_DOWNLOAD_DISABLED");return noticePackagePublisher.publish(input);},
    async extractProgressDocumentPdf(input){if(!genericProgressDocumentDownloadEnabled)throw new Error("GENERIC_PROGRESS_DOCUMENT_EXTRACTION_DISABLED");return extractProgressDocumentPdf(input);},
    invalidateSession:session.invalidate,
    status(){const uploadEvidence=domesticReportUploadPolicy.protocolEvidence??{};const domesticReportUploadProtocolEvidenceComplete=Object.keys(uploadEvidence).length===8&&Object.values(uploadEvidence).every(value=>value===true);return {session:session.status(),automaticAuthenticationReady:session.status().protocolVerified,sessionRefreshEnabled:false,enabledTemplateCount:registry.templates.filter(t=>t.enabled===true).length,genericMatterSummaryEnabled:genericSummary.status.enabled&&policy.genericMatterSummaryConstraints?.mcpExposureEnabled===true,genericMatterSummaryCandidateReady:genericSummary.status.enabled,genericMatterSummaryTemplateCount:genericSummary.status.templateCount,genericApplicationNumberSearchEnabled,genericApplicationNumberSearchCandidateReady:genericApplicationSearch!==null,genericProgressListingEnabled,genericDocumentListingEnabled,genericProgressDocumentListingEnabled,genericNoticeAttachmentListingEnabled,genericProgressDocumentDownloadEnabled,genericProgressDocumentExtractionEnabled:genericProgressDocumentDownloadEnabled,domesticReportUploadPreviewImplemented:domesticReportUploadPolicy.previewEnabled===true,domesticReportUploadCommitEnabled:domesticReportUploadPolicy.commitEnabled===true&&domesticReportUploadPolicy.mcpExposureEnabled===true&&domesticReportUploadProtocolEvidenceComplete,domesticReportUploadProtocolEvidenceComplete,documentMatterBindingVerified,allowedOperations:[...allowedOperations],credentialTarget:"EasyPAT/Automation",liveReady:session.status().protocolVerified&&registry.templates.some(t=>t.enabled===true&&t.boundMatterReference&&allowedOperations.includes(t.operation))};},
  });
}
