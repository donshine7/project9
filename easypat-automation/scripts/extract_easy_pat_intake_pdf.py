import hashlib
import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader

LABELS = {
    "출원종류": "applicationType",
    "출원인": "applicant",
    "발명자/창작자": "inventorInstruction",
    "실무자": "practitioner",
    "수임자": "assignee",
    "DB": "databaseManager",
    "소개자": "introducer",
    "비용": "fee",
    "견적서&위임계약서": "estimateAndPowerOfAttorney",
    "비고": "note",
}


def safe_value(value):
    value = value.strip(" :\t")
    if not value:
        return None
    if len(value) > 512 or any(ord(char) < 32 for char in value):
        raise ValueError("unsafe extracted value")
    return value


def main():
    if len(sys.argv) != 2:
        raise ValueError("input rejected")
    source = Path(sys.argv[1]).resolve(strict=True)
    if source.suffix.lower() != ".pdf" or not source.is_file() or source.stat().st_size < 5 or source.stat().st_size > 64 * 1024 * 1024:
        raise ValueError("input rejected")
    data = source.read_bytes()
    if not data.startswith(b"%PDF-"):
        raise ValueError("input rejected")
    reader = PdfReader(source)
    if reader.is_encrypted or len(reader.pages) < 1 or len(reader.pages) > 50:
        raise ValueError("pdf rejected")
    page_text = [page.extract_text() or "" for page in reader.pages]
    text = "\n".join(page_text)
    if not text or len(text) > 2 * 1024 * 1024:
        raise ValueError("pdf text rejected")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    fields = {}
    for label, key in LABELS.items():
        matches = [safe_value(line[len(label):]) for line in lines if line.startswith(label)]
        if len(matches) != 1:
            raise ValueError("required field rejected")
        fields[key] = matches[0]
    application_type = fields["applicationType"] or ""
    count_match = re.search(r"(?<!\d)(\d{1,3})\s*건", application_type)
    prefix_match = re.search(r"\(([A-Z]{1,4})로\s*생성\)", application_type)
    related = sorted(set(re.findall(r"(?<![A-Z0-9])(?:PPT|PT|P|T|D)\d{3,12}(?:-[A-Z0-9]+(?:\([A-Z0-9]+\))?)*(?![A-Z0-9])", text)))
    result = {
        "sourceFileName": source.name,
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "pageCount": len(reader.pages),
        "fields": fields,
        "requestedMatterCount": int(count_match.group(1)) if count_match else None,
        "requestedMatterPrefix": prefix_match.group(1) if prefix_match else None,
        "relatedMatterReferences": related,
        "rawTextReturned": False,
        "emailAddressesReturned": False,
        "contactDetailsReturned": False,
        "externalUploadPerformed": False,
    }
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"status": "extraction-failed"}, separators=(",", ":")), file=sys.stderr)
        sys.exit(1)
