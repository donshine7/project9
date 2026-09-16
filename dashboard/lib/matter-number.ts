export type MatterNumberKind =
  | 'domestic_patent'
  | 'overseas_patent'
  | 'pct'
  | 'priority_basis'
  | 'refiling'
  | 'other_matter'
  | 'appeal'
  | 'trademark'
  | 'design'
  | 'provisional_project';

export type ParsedMatterNumber = {
  normalized: string;
  office: '상상특허' | '상상플러스';
  kind: MatterNumberKind;
  countryCode: string | null;
  baseRef: string;
  parentRef: string | null;
  relationType: 'priority_basis' | 'refiling' | 'divisional' | 'foreign_family' | 'pct_family' | null;
  suffixes: string[];
};

export class MatterNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatterNumberError';
  }
}

export function normalizeMatterNumber(value: unknown) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, '');
}

// Tokenize before parsing: an unsupported suffix must never turn into a
// different, shorter case. Parenthetical suffixes remain opaque pending review.
export function matterReferenceTokens(text: string): string[] {
  const normalized = text.toUpperCase().replace(/[‐‑‒–—―]/g, '-');
  const pattern = /(?<![A-Z0-9-])[A-Z]{1,4}\d{5,8}(?:-[A-Z0-9]+|\([^\r\n)]*\))*(?![A-Z0-9(-])/g;
  return [...new Set([...normalized.matchAll(pattern)].map(match => match[0]))];
}

export function hasExactMatterReference(text: string, ref: string): boolean {
  return matterReferenceTokens(text).includes(normalizeMatterNumber(ref));
}

export function parseMatterNumber(value: unknown): ParsedMatterNumber {
  const normalized = normalizeMatterNumber(value);
  if (!normalized) throw new MatterNumberError('당소관리번호를 입력하세요.');

  // User-confirmed on 2026-09-11. Series members are distinct matters, not
  // automatically created groups or aliases of the unsuffixed case.
  const series = normalized.match(/^(P\d{6})-(S[1-9]\d*)$/);
  if (series) return parsed(normalized, '상상특허', 'domestic_patent', 'KR', normalized, null, null, [series[2]]);

  const chinaProvisional = normalized.match(/^(P\d{6}(?:-S[1-9]\d*)?)-CN\(PA\)$/);
  if (chinaProvisional) return parsed(normalized, '상상특허', 'overseas_patent', 'CN', chinaProvisional[1], chinaProvisional[1], 'foreign_family', ['CN', 'PA']);

  const seriesOverseas = normalized.match(/^(P\d{6}-S[1-9]\d*)-([A-Z]{2})(?:-([A-Z0-9]+(?:-[A-Z0-9]+)*))?$/);
  if (seriesOverseas) return parsed(normalized, '상상특허', 'overseas_patent', seriesOverseas[2], seriesOverseas[1], seriesOverseas[1], 'foreign_family', [seriesOverseas[2], ...(seriesOverseas[3]?.split('-') || [])]);

  // User-confirmed 2026-09-16: D identifies design matters. Preserve opaque
  // suffixes; classification does not establish aliases or family relations.
  if (/^D\d{6}(?:-[A-Z0-9]+|\([A-Z0-9-]+\))*$/.test(normalized)) {
    const country = normalized.match(/^D\d{6}-(US|JP|CN|EP|TH|KH|MN|CA|HK|PH|AU|ID|SG|IN)(?=-|\(|$)/)?.[1];
    return parsed(normalized, '상상특허', 'design', normalized.length === 7 ? 'KR' : country || null, normalized.slice(0, 7), null, null, normalized.length === 7 ? [] : [normalized.slice(7).replace(/^-/, '')]);
  }

  if (/^T\d{6}(?:-[A-Z0-9]+|\([A-Z0-9-]+\))*$/.test(normalized)) {
    const country = normalized.match(/^T\d{6}-(US|JP|CN|EP|TH|KH|MN|CA|HK|PH|AU|ID|SG|IN)(?=-|\(|$)/)?.[1];
    return parsed(normalized, '상상특허', 'trademark', normalized.length === 7 ? 'KR' : country || null, normalized.slice(0, 7), null, null, normalized.length === 7 ? [] : [normalized.slice(7).replace(/^-/, '')]);
  }

  if (/^PP\d{6}$/.test(normalized)) {
    return parsed(normalized, '상상플러스', 'domestic_patent', 'KR', normalized, null, null, []);
  }

  // User-confirmed on 2026-09-14. PPT identifies a provisional application
  // managed by Sangsang Plus and must remain distinct from PT/P/PP matters.
  if (/^PPT\d{6}$/.test(normalized)) {
    return parsed(normalized, '상상플러스', 'provisional_project', 'KR', normalized, null, null, []);
  }

  if (/^P\d{6}$/.test(normalized)) {
    return parsed(normalized, '상상특허', 'domestic_patent', 'KR', normalized, null, null, []);
  }

  // User-confirmed on 2026-09-14. DIV1, DIV2, ... identify distinct
  // divisional applications of the unsuffixed domestic patent matter.
  const divisional = normalized.match(/^(P\d{6})-(DIV[1-9]\d*)$/);
  if (divisional) {
    return parsed(normalized, '상상특허', 'domestic_patent', 'KR', divisional[1], divisional[1], 'divisional', [divisional[2]]);
  }

  const priorityBasis = normalized.match(/^(P\d{6})-PRO(\d+)$/);
  if (priorityBasis) {
    return parsed(normalized, '상상특허', 'priority_basis', 'KR', priorityBasis[1], priorityBasis[1], 'priority_basis', [`PRO${priorityBasis[2]}`]);
  }

  const refiling = normalized.match(/^(P\d{6})-RE$/);
  if (refiling) {
    return parsed(normalized, '상상특허', 'refiling', 'KR', refiling[1], refiling[1], 'refiling', ['RE']);
  }

  const pct = normalized.match(/^(P\d{6})-PCT(?:-([A-Z0-9]+(?:-[A-Z0-9]+)*))?$/);
  if (pct) {
    const extra = pct[2]?.split('-') ?? [];
    return parsed(normalized, '상상특허', 'pct', 'PCT', pct[1], pct[1], 'pct_family', ['PCT', ...extra]);
  }

  const overseas = normalized.match(/^(P\d{6})-([A-Z]{2})(?:-([A-Z0-9]+(?:-[A-Z0-9]+)*))?$/);
  if (overseas) {
    const extra = overseas[3]?.split('-') ?? [];
    return parsed(normalized, '상상특허', 'overseas_patent', overseas[2], overseas[1], overseas[1], 'foreign_family', [overseas[2], ...extra]);
  }

  if (/^S[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(normalized)) {
    return parsed(normalized, '상상특허', 'other_matter', null, normalized.split('-')[0], null, null, normalized.split('-').slice(1));
  }

  if (/^AT\d{6}(?:-[A-Z0-9]+)*$/.test(normalized)) {
    return parsed(normalized, '상상특허', 'appeal', null, normalized.split('-')[0], null, null, normalized.split('-').slice(1));
  }

  if (/^PT\d{6}(?:-[A-Z0-9]+)*$/.test(normalized)) {
    return parsed(normalized, '상상특허', 'provisional_project', 'KR', normalized.split('-')[0], null, null, normalized.split('-').slice(1));
  }

  throw new MatterNumberError(`지원하지 않는 당소관리번호 형식입니다: ${normalized}`);
}

function parsed(
  normalized: string,
  office: ParsedMatterNumber['office'],
  kind: MatterNumberKind,
  countryCode: string | null,
  baseRef: string,
  parentRef: string | null,
  relationType: ParsedMatterNumber['relationType'],
  suffixes: string[],
): ParsedMatterNumber {
  return { normalized, office, kind, countryCode, baseRef, parentRef, relationType, suffixes };
}
