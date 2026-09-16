import {createHash} from "node:crypto";
import {lstat,mkdir,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {consumeVerifiedDocumentSelection} from "./document-selection-context.mjs";
import {createDocumentDownloadTransport} from "./document-download-transport.mjs";
import {normalizeExactMatterReference} from "./matter-reference.mjs";

const defaultRoot=fileURLToPath(new URL("../../.local/downloads/",import.meta.url));

function verifiedPolicy(policy){
  const constraints=policy?.genericDownloadConstraints;
  if(!policy?.allowedOperations?.includes("download-document")||constraints?.enabled!==true||constraints?.mcpExposureEnabled!==true||
     constraints?.sourceTemplateId!=="matter-detail.documents.v1"||constraints?.freshVerifiedDocumentListRequired!==true||constraints?.sameOriginOnly!==true||
     constraints?.maximumBytes!==67108864||constraints?.overwriteAllowed!==false||constraints?.automaticRetryEnabled!==false||constraints?.callerSuppliedUploadPathAllowed!==false||
     policy?.genericDocumentConstraints?.enabled!==true||policy?.mutationOperationsEnabled!==false||policy?.arbitrarySqlEnabled!==false){
    throw new Error("GENERIC_DOWNLOAD_POLICY_REJECTED");
  }
  return constraints;
}

async function checkedDestination(root,matterReference,fileName){
  await mkdir(root,{recursive:true});const rootInfo=await lstat(root);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error("GENERIC_DOWNLOAD_PATH_REJECTED");
  const matterRoot=path.resolve(root,matterReference);if(path.dirname(matterRoot).toLowerCase()!==root.toLowerCase())throw new Error("GENERIC_DOWNLOAD_PATH_REJECTED");
  await mkdir(matterRoot,{recursive:true});const matterInfo=await lstat(matterRoot);
  if(!matterInfo.isDirectory()||matterInfo.isSymbolicLink()||path.resolve(await realpath(matterRoot)).toLowerCase()!==matterRoot.toLowerCase())throw new Error("GENERIC_DOWNLOAD_PATH_REJECTED");
  const destination=path.resolve(matterRoot,fileName);if(path.dirname(destination).toLowerCase()!==matterRoot.toLowerCase())throw new Error("GENERIC_DOWNLOAD_PATH_REJECTED");
  try{await lstat(destination);throw new Error("GENERIC_DOWNLOAD_DESTINATION_EXISTS");}catch(error){if(error?.code!=="ENOENT")throw error;}
  return destination;
}

export function createGenericDocumentDownloader({policy,prepareDownload,getSessionCookie,transport=createDocumentDownloadTransport(),root=defaultRoot}={}){
  const fixedPolicy=structuredClone(policy),resolvedRoot=path.resolve(root);
  return Object.freeze({async download(input){
    if(!input||Object.keys(input).sort().join(",")!=="expectedFileName,matterReference,position"||typeof prepareDownload!=="function"||typeof getSessionCookie!=="function"||typeof transport!=="function")throw new Error("GENERIC_DOWNLOAD_INPUT_REJECTED");
    verifiedPolicy(fixedPolicy);let matter,context,target,cookie,response;
    try{
      matter=normalizeExactMatterReference(input.matterReference);context=await prepareDownload({matterReference:matter,position:input.position,expectedFileName:input.expectedFileName});target=consumeVerifiedDocumentSelection(context);
      if(target.matterReference!==matter||target.position!==input.position||target.fileName!==input.expectedFileName)throw new Error("GENERIC_DOWNLOAD_SELECTION_REJECTED");
      const destination=await checkedDestination(resolvedRoot,matter,target.fileName);cookie=await getSessionCookie();response=await transport({uploadPath:target.uploadPath,cookie,expectedBytes:target.fileSizeBytes,extension:target.extension});
      if(!Buffer.isBuffer(response?.bytes)||response.size!==target.fileSizeBytes||response.bytes.length!==target.fileSizeBytes||typeof response.contentType!=="string")throw new Error("GENERIC_DOWNLOAD_RESPONSE_REJECTED");
      const sha256=createHash("sha256").update(response.bytes).digest("hex");await writeFile(destination,response.bytes,{flag:"wx",mode:0o600});
      return Object.freeze({matterReference:matter,position:target.position,fileName:target.fileName,fileSizeBytes:target.fileSizeBytes,contentType:response.contentType,sha256,path:destination,downloaded:true,alreadyPresent:false,overwritten:false,automaticRetryPerformed:false,serverMutationPerformed:false,serverUploadPathReturned:false});
    }catch(error){if(/^GENERIC_/.test(error?.message??"")||error?.code)throw error;throw new Error("GENERIC_DOWNLOAD_FAILED");}
    finally{cookie=null;context=null;target=null;response?.bytes?.fill(0);response=null;}
  }});
}
