import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { operationalDatabasePath, runtimeProfile } from './runtime-environment';
import { scanWikiMarkdownVault } from './wiki-markdown';
import { withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;

export type WikiScaleThresholds = {
  minDocuments: number;
  maxIssues: number;
  maxElapsedMs: number;
  maxStaleProposals: number;
  maxReviewReadyCount: number;
};

const DEFAULT_THRESHOLDS: WikiScaleThresholds = {
  minDocuments: 30,
  maxIssues: 0,
  maxElapsedMs: 15_000,
  maxStaleProposals: 0,
  maxReviewReadyCount: 20,
};

function check(value: unknown, message: string, status = 400, code = 'WIKI_SCALE_VALIDATION'): asserts value {
  if (!value) throw new WorkDbError(message, status, code);
}

function integer(value: number, label: string, minimum = 0) {
  check(Number.isInteger(value) && value >= minimum, `${label} 값이 올바르지 않습니다.`);
  return value;
}

function count(db: DatabaseSync, sql: string) {
  return Number((db.prepare(sql).get() as Row)?.count ?? 0);
}

export async function assessWikiScaleReadiness(input: { thresholds?: Partial<WikiScaleThresholds>; forceFull?: boolean } = {}) {
  const profile = runtimeProfile();
  check(profile !== 'operational', '운영 데이터에는 합성 Scale 평가를 기록하지 않습니다.', 409, 'WIKI_SCALE_OPERATIONAL_BLOCKED');
  const thresholds: WikiScaleThresholds = {
    minDocuments: integer(input.thresholds?.minDocuments ?? DEFAULT_THRESHOLDS.minDocuments, 'minDocuments', 1),
    maxIssues: integer(input.thresholds?.maxIssues ?? DEFAULT_THRESHOLDS.maxIssues, 'maxIssues'),
    maxElapsedMs: integer(input.thresholds?.maxElapsedMs ?? DEFAULT_THRESHOLDS.maxElapsedMs, 'maxElapsedMs', 1),
    maxStaleProposals: integer(input.thresholds?.maxStaleProposals ?? DEFAULT_THRESHOLDS.maxStaleProposals, 'maxStaleProposals'),
    maxReviewReadyCount: integer(input.thresholds?.maxReviewReadyCount ?? DEFAULT_THRESHOLDS.maxReviewReadyCount, 'maxReviewReadyCount'),
  };
  const scan = await scanWikiMarkdownVault({ forceFull: input.forceFull });
  const metrics = withDatabase((db) => ({
    documentCount: count(db, 'SELECT COUNT(*) AS count FROM wiki_document'),
    validDocumentCount: count(db, "SELECT COUNT(*) AS count FROM wiki_document WHERE parse_status='valid'"),
    markdownSourceCount: count(db, "SELECT COUNT(*) AS count FROM wiki_document_source_mode WHERE source_mode='markdown'"),
    legacySourceCount: count(db, "SELECT COUNT(*) AS count FROM wiki_document_source_mode WHERE source_mode='legacy_db'"),
    reviewReadyCount: count(db, "SELECT COUNT(*) AS count FROM wiki_proposal WHERE status IN ('ready_for_review','reviewed')"),
    staleProposalCount: count(db, "SELECT COUNT(*) AS count FROM wiki_proposal WHERE status IN ('stale_document','stale_evidence')"),
  }));
  const blockers: string[] = [];
  if (metrics.documentCount < thresholds.minDocuments) blockers.push(`문서 수 ${metrics.documentCount}/${thresholds.minDocuments}`);
  if (metrics.validDocumentCount !== metrics.documentCount) blockers.push(`유효하지 않은 문서 ${metrics.documentCount - metrics.validDocumentCount}개`);
  if (scan.issueCount > thresholds.maxIssues) blockers.push(`스캔 이슈 ${scan.issueCount}/${thresholds.maxIssues}`);
  if (scan.elapsedMs > thresholds.maxElapsedMs) blockers.push(`스캔 시간 ${scan.elapsedMs}ms/${thresholds.maxElapsedMs}ms`);
  if (metrics.staleProposalCount > thresholds.maxStaleProposals) blockers.push(`stale 제안 ${metrics.staleProposalCount}/${thresholds.maxStaleProposals}`);
  if (metrics.reviewReadyCount > thresholds.maxReviewReadyCount) blockers.push(`검토 대기 ${metrics.reviewReadyCount}/${thresholds.maxReviewReadyCount}`);
  const result = {
    id: randomUUID(),
    profile,
    status: blockers.length === 0 ? 'passed' as const : 'failed' as const,
    scan,
    ...metrics,
    thresholds,
    blockers,
    createdAt: new Date().toISOString(),
  };
  withDatabase((db) => db.prepare(`
    INSERT INTO wiki_scale_run(
      id,profile,scan_id,status,document_count,valid_document_count,changed_document_count,unchanged_document_count,
      issue_count,markdown_source_count,legacy_source_count,review_ready_count,stale_proposal_count,elapsed_ms,
      thresholds_json,blockers_json,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    result.id, result.profile, result.scan.scanId, result.status, result.documentCount, result.validDocumentCount,
    result.scan.changedCount, result.scan.unchangedCount, result.scan.issueCount, result.markdownSourceCount,
    result.legacySourceCount, result.reviewReadyCount, result.staleProposalCount, result.scan.elapsedMs,
    JSON.stringify(result.thresholds), JSON.stringify(result.blockers), result.createdAt,
  ));
  return result;
}

function hasTable(db: DatabaseSync, name: string) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function sha256File(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function inspectOperationalWikiReadiness(input: { databasePath?: string; vaultPath?: string } = {}) {
  const database = path.resolve(input.databasePath ?? operationalDatabasePath());
  const vault = path.resolve(input.vaultPath ?? String.raw`C:\ChatGPT\AI-Work\20_업무자동화\상상업무자동화_Wiki`);
  const blockers: string[] = [];
  const databaseExists = existsSync(database) && lstatSync(database).isFile();
  const vaultExists = existsSync(vault) && lstatSync(vault).isDirectory() && !lstatSync(vault).isSymbolicLink();
  if (!databaseExists) blockers.push('운영 DB 파일이 없습니다.');
  if (!vaultExists) blockers.push('업무 Wiki Vault가 없습니다.');
  const summary: Row = {
    databasePath: database,
    databaseExists,
    databaseBytes: databaseExists ? lstatSync(database).size : null,
    databaseSha256: databaseExists ? sha256File(database) : null,
    vaultPath: vault,
    vaultExists,
    schemaReady: false,
    documentCount: 0,
    validDocumentCount: 0,
    legacySourceCount: 0,
    markdownSourceCount: 0,
    cutoverCandidateCount: 0,
  };
  if (databaseExists) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const required = ['wiki_document', 'wiki_document_source_mode', 'wiki_proposal', 'wiki_proposal_review', 'entity_wiki_revision'];
      summary.schemaReady = required.every((name) => hasTable(db, name));
      if (!summary.schemaReady) blockers.push('운영 DB에 Wiki Markdown 전환 스키마가 모두 적용되지 않았습니다.');
      else {
        summary.documentCount = count(db, 'SELECT COUNT(*) AS count FROM wiki_document');
        summary.validDocumentCount = count(db, "SELECT COUNT(*) AS count FROM wiki_document WHERE parse_status='valid'");
        summary.legacySourceCount = count(db, "SELECT COUNT(*) AS count FROM wiki_document_source_mode WHERE source_mode='legacy_db'");
        summary.markdownSourceCount = count(db, "SELECT COUNT(*) AS count FROM wiki_document_source_mode WHERE source_mode='markdown'");
        summary.cutoverCandidateCount = count(db, `
          SELECT COUNT(DISTINCT d.doc_id) AS count
          FROM wiki_document d
          JOIN wiki_document_source_mode s ON s.doc_id=d.doc_id AND s.source_mode='legacy_db'
          JOIN wiki_proposal p ON p.doc_id=d.doc_id AND p.status='applied_observed'
          JOIN wiki_proposal_review r ON r.proposal_id=p.id AND r.action='accept_for_manual_apply'
          WHERE d.parse_status='valid'
        `);
      }
    } finally {
      db.close();
    }
  }
  if (summary.documentCount === 0) blockers.push('운영 Wiki 인덱스에 문서가 없습니다.');
  if (summary.validDocumentCount !== summary.documentCount) blockers.push('운영 Wiki 인덱스에 유효하지 않은 문서가 있습니다.');
  if (summary.cutoverCandidateCount < 1) blockers.push('사람 검토까지 완료된 컷오버 후보가 없습니다.');
  return {
    schema: 'wiki-operational-readiness-v1',
    inspectedAt: new Date().toISOString(),
    readOnly: true,
    readyForPilot: blockers.length === 0,
    summary,
    blockers,
  };
}
