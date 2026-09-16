const selections=new WeakMap();

export function createVerifiedDocumentSelection(target){
  if(!target||typeof target!=="object"||typeof target.matterReference!=="string"||!Number.isInteger(target.position)||
     typeof target.fileName!=="string"||typeof target.uploadPath!=="string"||!Number.isSafeInteger(target.fileSizeBytes)||typeof target.extension!=="string"){
    throw new Error("DOCUMENT_SELECTION_CONTEXT_REJECTED");
  }
  const context=Object.freeze({matterReference:target.matterReference,position:target.position,fileName:target.fileName,fileSizeBytes:target.fileSizeBytes,verified:true,serverUploadPathIncluded:false});
  selections.set(context,Object.freeze({...target}));
  return context;
}

export function consumeVerifiedDocumentSelection(context){
  const target=selections.get(context);selections.delete(context);
  if(!target||context?.verified!==true)throw new Error("DOCUMENT_SELECTION_CONTEXT_REJECTED");
  return target;
}
