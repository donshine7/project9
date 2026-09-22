const REFERENCE = /^(PPT|PT|P|T|D)(\d{3,12})((?:-[A-Z0-9]+(?:\([A-Z0-9]+\))?)*)$/;

const FAMILIES = Object.freeze({
  T: "trademark",
  P: "patent",
  PT: "sangsang-provisional",
  PPT: "sangsang-plus-provisional",
  D: "design",
});

// This parser is intentionally narrower than the legacy UI helper. It is used
// only by the HTTPS generalization path, where an input becomes a query value.
// Suffixes are preserved as identity data; they are never removed or used to
// infer that two matters belong to the same group.
export function parseMatterReference(value) {
  if (typeof value !== "string") throw new Error("MATTER_REFERENCE_REJECTED");
  const normalized = value.trim().toUpperCase();
  if (normalized.length > 64) throw new Error("MATTER_REFERENCE_REJECTED");
  const match = REFERENCE.exec(normalized);
  if (!match) throw new Error("MATTER_REFERENCE_REJECTED");
  const suffixes = match[3] ? match[3].slice(1).split("-") : [];
  return Object.freeze({
    value: normalized,
    prefix: match[1],
    number: match[2],
    family: FAMILIES[match[1]],
    suffixes: Object.freeze(suffixes),
  });
}

export function normalizeExactMatterReference(value) {
  return parseMatterReference(value).value;
}
