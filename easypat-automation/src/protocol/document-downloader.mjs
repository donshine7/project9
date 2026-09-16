import {createHash} from "node:crypto";
import {lstat,mkdir,readFile,realpath,writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {resolveDocumentDownload} from "./document-list.mjs";
import {createDocumentDownloadTransport} from "./document-download-transport.mjs";

const defaultRoot=fileURLToPath(new URL("../../.local/downloads/P261793/",import.meta.url));

function policySelection(policy,input){
  const constraints=policy?.documentDownloadConstraints;
  const selection=constraints?.allowedSelections?.find(item=>item?.position===input.position&&item?.expectedFileName===input.expectedFileName);
  if(!policy?.allowedOperations?.includes("download-document")||constraints?.enabled!==true||constraints?.matterReference!=="P261793"||constraints?.sourceTemplateId!=="matter-detail.documents.v1"||constraints?.sameOriginOnly!==true||constraints?.freshVerifiedListRequired!==true||constraints?.maximumBytes!==67108864||!selection||typeof selection.expectedSha256!=="string"||!/^[a-f0-9]{64}$/.test(selection.expectedSha256))throw new Error("DOCUMENT_DOWNLOAD_POLICY_REJECTED");
  return selection;
}

async function checkedDestination(root,fileName){
  await mkdir(root,{recursive:true});
  const rootInfo=await lstat(root);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||path.resolve(await realpath(root)).toLowerCase()!==root.toLowerCase())throw new Error("DOCUMENT_DOWNLOAD_PATH_REJECTED");
  const destination=path.resolve(root,fileName);
  if(path.dirname(destination).toLowerCase()!==root.toLowerCase())throw new Error("DOCUMENT_DOWNLOAD_PATH_REJECTED");
  return destination;
}

function safeResult(target,sha256,destination,{downloaded,alreadyPresent}){
  return Object.freeze({matterReference:"P261793",position:target.position,fileName:target.fileName,fileSizeBytes:target.fileSizeBytes,contentType:"image/jpeg",sha256,path:destination,downloaded,alreadyPresent,overwritten:false,automaticRetryPerformed:false,serverMutationPerformed:false,serverUploadPathReturned:false});
}

export function createDocumentDownloader({policy,readDocuments,getSessionCookie,transport=createDocumentDownloadTransport(),root=defaultRoot}={}){
  const resolvedRoot=path.resolve(root);
  return Object.freeze({async download(input){
    if(!input||Object.keys(input).sort().join(",")!=="expectedFileName,matterReference,position"||input.matterReference!=="P261793"||typeof readDocuments!=="function"||typeof getSessionCookie!=="function"||typeof transport!=="function")throw new Error("DOCUMENT_DOWNLOAD_INPUT_REJECTED");
    const selection=policySelection(policy,input);
    let result,target,cookie,response,localBytes;
    try{
      result=await readDocuments({templateId:"matter-detail.documents.v1",matterReference:"P261793"});
      target=resolveDocumentDownload(result,{position:input.position,expectedFileName:input.expectedFileName},{contextBinding:"captured-p261793-fixed-document-group"});
      const destination=await checkedDestination(resolvedRoot,target.fileName);
      try{
        const existing=await lstat(destination);
        if(!existing.isFile()||existing.isSymbolicLink()||existing.size!==target.fileSizeBytes||path.resolve(await realpath(destination)).toLowerCase()!==destination.toLowerCase())throw new Error("DOCUMENT_DOWNLOAD_EXISTING_FILE_REJECTED");
        localBytes=await readFile(destination);
        const sha256=createHash("sha256").update(localBytes).digest("hex");
        if(sha256!==selection.expectedSha256)throw new Error("DOCUMENT_DOWNLOAD_EXISTING_FILE_REJECTED");
        return safeResult(target,sha256,destination,{downloaded:false,alreadyPresent:true});
      }catch(error){if(error?.code!=="ENOENT")throw error;}
      cookie=await getSessionCookie();
      response=await transport({uploadPath:target.uploadPath,cookie,expectedBytes:target.fileSizeBytes,extension:target.extension});
      if(!Buffer.isBuffer(response?.bytes)||response.size!==target.fileSizeBytes||response.bytes.length!==target.fileSizeBytes||response.contentType!=="image/jpeg")throw new Error("DOCUMENT_DOWNLOAD_RESPONSE_REJECTED");
      const sha256=createHash("sha256").update(response.bytes).digest("hex");
      if(sha256!==selection.expectedSha256)throw new Error("DOCUMENT_DOWNLOAD_HASH_MISMATCH");
      await writeFile(destination,response.bytes,{flag:"wx",mode:0o600});
      return safeResult(target,sha256,destination,{downloaded:true,alreadyPresent:false});
    }catch(error){if(error?.code)throw error;throw new Error("DOCUMENT_DOWNLOAD_FAILED");}
    finally{cookie=null;result=null;target=null;localBytes?.fill(0);localBytes=null;response?.bytes?.fill(0);response=null;}
  }});
}
