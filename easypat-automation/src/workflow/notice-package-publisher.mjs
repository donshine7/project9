import {createHash,randomUUID} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import {copyFile,lstat,mkdir,open,readFile,realpath,rename,stat,unlink,writeFile} from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
import {consumeVerifiedDocumentSelection} from "../protocol/document-selection-context.mjs";
import {createDocumentDownloadTransport} from "../protocol/document-download-transport.mjs";
import {normalizeExactMatterReference} from "../protocol/matter-reference.mjs";
import {createUtf8ZipArchive} from "./utf8-zip.mjs";

const projectRoot=path.resolve(fileURLToPath(new URL("../../",import.meta.url)));
const defaultStagingRoot=path.join(projectRoot,".local","notice-packages");
const MAX_PACKAGE_BYTES=512*1024*1024;

export class NoticePackagePublisherError extends Error{constructor(code,details={}){super(code);this.name="NoticePackagePublisherError";this.code=code;this.details=details;}}

function sha256(bytes){return createHash("sha256").update(bytes).digest("hex");}
function inside(root,candidate){const relative=path.relative(root,candidate);return relative===""||!relative.startsWith(`..${path.sep}`)&&relative!==".."&&!path.isAbsolute(relative);}
function exactInput(input){return input&&Object.keys(input).sort().join(",")==="dueDate,expectedItems,matterReference,noticeDate,oaSequence,progressDocument,sequence";}
function signature(bytes,extension){
  if(!Buffer.isBuffer(bytes)||bytes.length<1)throw new NoticePackagePublisherError("NOTICE_ATTACHMENT_EMPTY");
  if(extension==="pdf"&&!bytes.subarray(0,5).equals(Buffer.from("%PDF-")))throw new NoticePackagePublisherError("NOTICE_ATTACHMENT_SIGNATURE_REJECTED");
  if(extension==="zip"){
    const header=bytes.length>=4?bytes.readUInt32LE(0):0;
    if(![0x04034b50,0x06054b50,0x08074b50].includes(header))throw new NoticePackagePublisherError("NOTICE_ATTACHMENT_SIGNATURE_REJECTED");
  }
  return["pdf","zip"].includes(extension)?"verified":"opaque-allowed-extension";
}
function archiveEntry(fileName,count){return count===1?fileName:`duplicate-${count}/${fileName}`;}
function run(command,args,{cwd}={}){return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]}),out=[],err=[];let outSize=0,errSize=0;child.stdout.on("data",chunk=>{if(outSize<65536){const bytes=Buffer.from(chunk);out.push(bytes);outSize+=bytes.length;}});child.stderr.on("data",chunk=>{if(errSize<65536){const bytes=Buffer.from(chunk);err.push(bytes);errSize+=bytes.length;}});child.on("error",()=>reject(new NoticePackagePublisherError("ARCHIVE_COMMAND_FAILED")));child.on("close",code=>{const stdoutBytes=Buffer.concat(out),stderrBytes=Buffer.concat(err);code===0?resolve({stdout:stdoutBytes.toString("utf8"),stderr:stderrBytes.toString("utf8"),stdoutBytes,stderrBytes}):reject(new NoticePackagePublisherError("ARCHIVE_COMMAND_FAILED"));});});}
async function hashFile(filePath){return sha256(await readFile(filePath));}

export function createNoticePackagePublisher({policy,preparePackage,getSessionCookie,transport,stagingRoot=defaultStagingRoot,archiveCommand=path.join(process.env.SystemRoot||"C:\\Windows","System32","tar.exe")}={}){
  const fixedPolicy=structuredClone(policy),constraint=fixedPolicy?.noticePackageDownloadConstraints;
  if(constraint?.enabled!==true||constraint.sourceTemplateId!=="matter-detail.attachments.all.v1"||constraint.freshVerifiedListRequired!==true||constraint.sameOriginOnly!==true||constraint.maximumBytes!==67108864||constraint.maximumPackageBytes!==MAX_PACKAGE_BYTES||constraint.allowMissingContentTypeForVerifiedAttachment!==true||constraint.overwriteAllowed!==false||constraint.automaticRetryEnabled!==false||constraint.callerSuppliedUploadPathAllowed!==false||typeof constraint.destinationRoot!=="string"||typeof preparePackage!=="function"||typeof getSessionCookie!=="function"||transport!==undefined&&typeof transport!=="function")throw new NoticePackagePublisherError("NOTICE_PACKAGE_CONFIGURATION_REJECTED");
  const downloadTransport=transport??createDocumentDownloadTransport({allowMissingContentType:true});
  const destinationRoot=path.resolve(constraint.destinationRoot),fixedStagingRoot=path.resolve(stagingRoot);
  return Object.freeze({
    async publish(input){
      if(!exactInput(input))throw new NoticePackagePublisherError("NOTICE_PACKAGE_INPUT_REJECTED");
      let matter;
      try{matter=normalizeExactMatterReference(input.matterReference);}catch{throw new NoticePackagePublisherError("NOTICE_PACKAGE_INPUT_REJECTED");}
      if(input.progressDocument!=="의견제출통지서"||!Number.isInteger(input.oaSequence)||input.oaSequence<1||input.oaSequence>50||!/^\d{4}-\d{2}-\d{2}$/.test(input.noticeDate)||!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)||input.sequence!==null&&typeof input.sequence!=="string"||!Array.isArray(input.expectedItems)||input.expectedItems.length<1||input.expectedItems.length>500)throw new NoticePackagePublisherError("NOTICE_PACKAGE_INPUT_REJECTED");
      const expectedFileName=`[${matter}] ${input.oaSequence}OA (${input.noticeDate})(${input.dueDate}).zip`;
      const destinationInfo=await lstat(destinationRoot).catch(()=>null);if(!destinationInfo?.isDirectory()||destinationInfo.isSymbolicLink())throw new NoticePackagePublisherError("NOTICE_DESTINATION_REJECTED");
      const destinationReal=await realpath(destinationRoot);if(path.resolve(destinationReal).toLocaleLowerCase("en-US")!==destinationRoot.toLocaleLowerCase("en-US"))throw new NoticePackagePublisherError("NOTICE_DESTINATION_REJECTED");
      const finalPath=path.join(destinationRoot,expectedFileName);if(!inside(destinationRoot,finalPath))throw new NoticePackagePublisherError("NOTICE_DESTINATION_REJECTED");
      if(await lstat(finalPath).catch(()=>null))throw new NoticePackagePublisherError("NOTICE_DESTINATION_EXISTS",{expectedFileName});
      await mkdir(fixedStagingRoot,{recursive:true});
      const stagingReal=await realpath(fixedStagingRoot);if(!inside(path.resolve(projectRoot,".local"),stagingReal))throw new NoticePackagePublisherError("NOTICE_STAGING_REJECTED");
      const runRoot=path.join(fixedStagingRoot,`${matter}-${input.noticeDate}-${randomUUID()}`),archiveRoot=path.join(runRoot,"archive"),validationRoot=path.join(runRoot,"validation");
      await mkdir(archiveRoot,{recursive:true});await mkdir(validationRoot,{recursive:true});
      let prepared,cookie;
      try{
        const request={matterReference:matter,progressDocument:input.progressDocument,noticeDate:input.noticeDate,expectedItems:input.expectedItems};if(input.sequence)request.sequence=input.sequence;
        prepared=await preparePackage(request);
        if(prepared.matterReference!==matter||prepared.noticeDate!==input.noticeDate||prepared.dueDate!==input.dueDate||prepared.count!==input.expectedItems.length||prepared.selections?.length!==prepared.count)throw new NoticePackagePublisherError("NOTICE_PACKAGE_FRESH_LIST_MISMATCH");
        cookie=await getSessionCookie();
        const names=new Map(),items=[];let totalBytes=0;
        for(let index=0;index<prepared.items.length;index++){
          const metadata=prepared.items[index],selection=consumeVerifiedDocumentSelection(prepared.selections[index]);
          if(selection.matterReference!==matter||selection.position!==metadata.position||selection.fileName!==metadata.fileName||selection.fileSizeBytes!==metadata.fileSizeBytes)throw new NoticePackagePublisherError("NOTICE_PACKAGE_SELECTION_MISMATCH");
          totalBytes+=selection.fileSizeBytes;if(totalBytes>MAX_PACKAGE_BYTES)throw new NoticePackagePublisherError("NOTICE_PACKAGE_TOO_LARGE");
          const response=await downloadTransport({uploadPath:selection.uploadPath,cookie,expectedBytes:selection.fileSizeBytes,extension:selection.extension});
          if(response.size!==selection.fileSizeBytes||response.bytes.length!==selection.fileSizeBytes)throw new NoticePackagePublisherError("NOTICE_ATTACHMENT_LENGTH_MISMATCH");
          const occurrence=(names.get(selection.fileName)??0)+1;names.set(selection.fileName,occurrence);
          const entry=archiveEntry(selection.fileName,occurrence),entryPath=path.resolve(archiveRoot,...entry.split("/"));if(!inside(archiveRoot,entryPath))throw new NoticePackagePublisherError("NOTICE_ARCHIVE_ENTRY_REJECTED");
          await mkdir(path.dirname(entryPath),{recursive:true});const handle=await open(entryPath,"wx",0o600);try{await handle.writeFile(response.bytes);}finally{await handle.close();}
          const digest=sha256(response.bytes),verifiedSignature=signature(response.bytes,selection.extension);response.bytes.fill(0);
          items.push({sourcePosition:metadata.position,documentName:metadata.documentName,registeredAt:metadata.registeredAt,originalFileName:selection.fileName,archiveEntry:entry,fileSizeBytes:selection.fileSizeBytes,sha256:digest,contentType:response.contentType,signature:verifiedSignature});
        }
        const manifest={schemaVersion:1,matterReference:matter,noticeKind:"opinion_submission",oaSequence:input.oaSequence,noticeDate:input.noticeDate,dueDate:input.dueDate,progressSequence:input.sequence,itemCount:items.length,items,verifiedAt:new Date().toISOString()};
        const manifestEntry="download-manifest.json";await writeFile(path.join(archiveRoot,manifestEntry),JSON.stringify(manifest,null,2),{encoding:"utf8",mode:0o600,flag:"wx"});
        const entries=[...items.map(item=>item.archiveEntry),manifestEntry],zipPath=path.join(runRoot,expectedFileName);
        const zipEncoding=await createUtf8ZipArchive({sourceRoot:archiveRoot,outputPath:zipPath,entries});if(zipEncoding.utf8FileNamesVerified!==true||zipEncoding.entryCount!==entries.length)throw new NoticePackagePublisherError("NOTICE_ARCHIVE_FILENAME_ENCODING_REJECTED");
        await run(archiveCommand,["-xf",zipPath,"-C",validationRoot]);
        for(const item of items){const extracted=path.resolve(validationRoot,...item.archiveEntry.split("/"));if(!inside(validationRoot,extracted))throw new NoticePackagePublisherError("NOTICE_ARCHIVE_CONTENT_REJECTED");const info=await lstat(extracted);if(!info.isFile()||info.isSymbolicLink()||info.size!==item.fileSizeBytes||await hashFile(extracted)!==item.sha256)throw new NoticePackagePublisherError("NOTICE_ARCHIVE_CONTENT_REJECTED");}
        const extractedManifest=JSON.parse(await readFile(path.join(validationRoot,manifestEntry),"utf8"));if(extractedManifest.itemCount!==items.length||extractedManifest.matterReference!==matter)throw new NoticePackagePublisherError("NOTICE_ARCHIVE_CONTENT_REJECTED");
        const zipInfo=await stat(zipPath),zipSha256=await hashFile(zipPath),temporaryPath=path.join(destinationRoot,`.${expectedFileName}.${randomUUID()}.partial`);
        try{
          await copyFile(zipPath,temporaryPath,fsConstants.COPYFILE_EXCL);
          const copied=await stat(temporaryPath);if(copied.size!==zipInfo.size||await hashFile(temporaryPath)!==zipSha256)throw new NoticePackagePublisherError("NOTICE_DESTINATION_COPY_REJECTED");
          if(await lstat(finalPath).catch(()=>null))throw new NoticePackagePublisherError("NOTICE_DESTINATION_EXISTS",{expectedFileName});
          await rename(temporaryPath,finalPath);
        }catch(error){try{await unlink(temporaryPath);}catch{}throw error;}
        const finalInfo=await lstat(finalPath);if(!finalInfo.isFile()||finalInfo.isSymbolicLink()||finalInfo.size!==zipInfo.size||await hashFile(finalPath)!==zipSha256)throw new NoticePackagePublisherError("NOTICE_DESTINATION_VERIFY_REJECTED");
        return Object.freeze({matterReference:matter,noticeKind:"opinion_submission",oaSequence:input.oaSequence,noticeDate:input.noticeDate,dueDate:input.dueDate,sequence:input.sequence,expectedFileName,destinationPath:finalPath,stagingPath:runRoot,itemCount:items.length,items:Object.freeze(items.map(item=>Object.freeze(item))),fileSizeBytes:zipInfo.size,sha256:zipSha256,published:true,overwritten:false,automaticRetryPerformed:false,serverMutationPerformed:false,serverUploadPathReturned:false});
      }catch(error){if(error instanceof NoticePackagePublisherError)throw error;const safeCode=typeof error?.code==="string"&&/^[A-Z0-9_-]+$/.test(error.code)?error.code:null;throw new NoticePackagePublisherError(safeCode??"NOTICE_PACKAGE_PUBLISH_REJECTED",error?.details);}
      finally{cookie=null;prepared=null;}
    },
  });
}
