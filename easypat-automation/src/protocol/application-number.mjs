const APPLICATION_NUMBER=/^[A-Z0-9](?:[A-Z0-9./()-]{1,62}[A-Z0-9])$/;

// EasyPAT stores domestic and international application numbers with their
// punctuation. Preserve that punctuation, but reject SQL wildcard characters,
// whitespace and every non-ASCII/control character at the public boundary.
export function normalizeExactApplicationNumber(value){
  if(typeof value!=="string")throw new Error("APPLICATION_NUMBER_REJECTED");
  const normalized=value.trim().toUpperCase();
  if(value!==value.trim()||!APPLICATION_NUMBER.test(normalized)||/[\p{Cc}\p{Cs}\s%_]/u.test(normalized)){
    throw new Error("APPLICATION_NUMBER_REJECTED");
  }
  return normalized;
}
