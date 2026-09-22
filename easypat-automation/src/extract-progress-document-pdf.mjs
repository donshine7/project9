import {extractProgressDocumentPdf} from "./extraction/progress-document-pdf.mjs";

let stage="input";
try{
  const argv=process.argv.slice(2);
  if(argv.length!==4||argv[0]!=="--matter-reference"||argv[2]!=="--file-name")throw new Error("INPUT_REJECTED");
  stage="extract";const extraction=await extractProgressDocumentPdf({matterReference:argv[1],fileName:argv[3]});
  console.log(JSON.stringify({status:"progress-document-pdf-extracted",extraction}));
}catch{
  console.error(JSON.stringify({status:"progress-document-pdf-extraction-failed",failureStage:stage,rawTextReturned:false,emailAddressesReturned:false,contactDetailsReturned:false,externalUploadPerformed:false}));process.exitCode=1;
}
