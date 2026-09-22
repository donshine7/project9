import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { pathIsInside, resolveWikiVaultPath, runtimeProfile } from './runtime-environment';
import { transaction, withDatabase, WorkDbError } from './work-db';

const execFileAsync = promisify(execFile);
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const ACTIVE_DIRECTORIES = new Set([
  '00_Home',
  '10_Matters',
  '20_Organizations',
  '30_People',
  '40_Groups',
  '50_Knowledge',
  '60_Notes',
]);
const ALLOWED_FIELDS = new Set([
  'schema_version',
  'doc_id',
  'document_type',
  'entity_type',
  'entity_id',
  'title',
  'aliases',
  'tags',
]);
const ENTITY_TABLES: Record<string, string> = {
  matter: 'matter',
  organization: 'organization',
  person: 'person',
  group: 'matter_group',
};

type FrontmatterValue = string | string[] | null;
export type WikiFrontmatter = {
  schema_version: 'wiki-md-v1';
  doc_id: string;
  document_type: 'entity_wiki' | 'knowledge' | 'note';
  entity_type?: 'matter' | 'organization' | 'person' | 'group' | 'topic' | null;
  entity_id?: string | null;
  title: string;
  aliases?: string[];
  tags?: string[];
};
type ScanIssue = { severity: 'warning' | 'error'; code: string; relativePath: string | null; docId: string | null; detail: string };
type Candidate = {
  relativePath: string;
  byteHash: string;
  textHash: string;
  fileSize: number;
  mtimeMs: number;
  frontmatter: WikiFrontmatter;
  historyObjectPath: string;
  gitCommit: string | null;
  gitBlob: string | null;
  gitStatus: 'committed' | 'uncommitted' | 'unavailable';
};

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function posixRelative(root: string, candidate: string) {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function parseInlineList(raw: string) {
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  const values: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? '' : character;
      current += character;
    } else if (character === ',' && !quote) {
      values.push(parseScalar(current.trim(), true) as string);
      current = '';
    } else current += character;
  }
  if (quote) throw new Error('닫히지 않은 인용부호가 있습니다.');
  values.push(parseScalar(current.trim(), true) as string);
  return values;
}

function parseScalar(raw: string, listItem = false): FrontmatterValue {
  if (!raw) throw new Error('빈 frontmatter 값은 허용하지 않습니다. null을 명시하세요.');
  if (!listItem && raw.startsWith('[') && raw.endsWith(']')) return parseInlineList(raw);
  if (!listItem && /^(null|~)$/i.test(raw)) return null;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'string') throw new Error('문자열 값만 허용합니다.');
    return parsed;
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'");
  if (/^(true|false|[-+]?\d+(?:\.\d+)?)$/i.test(raw)) throw new Error('boolean과 숫자 값은 허용하지 않습니다.');
  if (/[[\]{}]/.test(raw)) throw new Error('지원하지 않는 YAML 구조입니다.');
  return raw;
}

function stringValue(value: FrontmatterValue | undefined, name: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} 값이 올바르지 않습니다.`);
  return value.trim();
}

function optionalString(value: FrontmatterValue | undefined, name: string, max: number) {
  if (value === undefined || value === null) return null;
  return stringValue(value, name, max);
}

function stringList(value: FrontmatterValue | undefined, name: string, maxItems: number) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => !item || item.length > 300)) {
    throw new Error(`${name} 목록이 올바르지 않습니다.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${name}에 중복 값이 있습니다.`);
  return value;
}

export function parseWikiMarkdown(bytes: Buffer) {
  if (bytes.length > MAX_MARKDOWN_BYTES) throw new Error(`Markdown은 ${MAX_MARKDOWN_BYTES} bytes 이하여야 합니다.`);
  const source = bytes.toString('utf8').replace(/^\uFEFF/, '');
  const normalized = source.replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) throw new Error('문서 첫 줄에 YAML frontmatter가 필요합니다.');
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('YAML frontmatter 종료 구분자가 없습니다.');
  const rawFrontmatter = normalized.slice(4, end);
  const values: Record<string, FrontmatterValue> = {};
  for (const [index, line] of rawFrontmatter.split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) throw new Error(`${index + 2}행: 중첩 YAML은 허용하지 않습니다.`);
    const match = line.match(/^([a-z_][a-z0-9_]*):(?:\s*)(.+)$/);
    if (!match) throw new Error(`${index + 2}행: key: value 형식이 아닙니다.`);
    const [, key, raw] = match;
    if (!ALLOWED_FIELDS.has(key)) throw new Error(`${key} 필드는 허용되지 않습니다.`);
    if (Object.hasOwn(values, key)) throw new Error(`${key} 필드가 중복되었습니다.`);
    values[key] = parseScalar(raw.trim());
  }

  const schemaVersion = stringValue(values.schema_version, 'schema_version', 30);
  if (schemaVersion !== 'wiki-md-v1') throw new Error('schema_version은 wiki-md-v1이어야 합니다.');
  const docId = stringValue(values.doc_id, 'doc_id', 132);
  if (!/^wiki-[a-z0-9][a-z0-9-]{2,127}$/.test(docId)) throw new Error('doc_id 형식이 올바르지 않습니다.');
  const documentType = stringValue(values.document_type, 'document_type', 30);
  if (!['entity_wiki', 'knowledge', 'note'].includes(documentType)) throw new Error('document_type이 올바르지 않습니다.');
  const title = stringValue(values.title, 'title', 300);
  const entityType = optionalString(values.entity_type, 'entity_type', 30);
  const entityId = optionalString(values.entity_id, 'entity_id', 300);
  const aliases = stringList(values.aliases, 'aliases', 30);
  const tags = stringList(values.tags, 'tags', 50);
  if (tags?.some((tag) => !/^[^#\s][^\s]{0,99}$/.test(tag))) throw new Error('tags 형식이 올바르지 않습니다.');

  if (documentType === 'entity_wiki') {
    if (!entityType || !Object.hasOwn(ENTITY_TABLES, entityType) || !entityId) throw new Error('entity_wiki에는 유효한 entity_type과 entity_id가 필요합니다.');
  } else if ((entityType !== null && entityType !== 'topic') || (entityId !== null && !entityId)) {
    throw new Error('knowledge와 note의 entity_type은 topic 또는 null이어야 합니다.');
  }

  const frontmatter: WikiFrontmatter = {
    schema_version: 'wiki-md-v1',
    doc_id: docId,
    document_type: documentType as WikiFrontmatter['document_type'],
    entity_type: entityType as WikiFrontmatter['entity_type'],
    entity_id: entityId,
    title,
    ...(aliases ? { aliases } : {}),
    ...(tags ? { tags } : {}),
  };
  return { frontmatter, body: normalized.slice(end + 5), normalized };
}

async function writeHistoryObject(vaultRoot: string, byteHash: string, bytes: Buffer) {
  const relative = `.sspat-history/objects/${byteHash.slice(0, 2)}/${byteHash}.md`;
  const target = path.join(vaultRoot, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(target);
    if (sha256(existing) !== byteHash) throw new Error('이력 객체 hash 충돌을 감지했습니다.');
  }
  return relative;
}

async function gitMetadata(vaultRoot: string, absolutePath: string, relativePath: string) {
  try {
    const { stdout: headOutput } = await execFileAsync('git', ['-C', vaultRoot, 'rev-parse', 'HEAD'], { windowsHide: true, timeout: 5000 });
    const { stdout: blobOutput } = await execFileAsync('git', ['-C', vaultRoot, 'hash-object', '--no-filters', absolutePath], { windowsHide: true, timeout: 5000 });
    const { stdout: statusOutput } = await execFileAsync('git', ['-C', vaultRoot, 'status', '--porcelain=v1', '--', relativePath], { windowsHide: true, timeout: 5000 });
    const committed = !statusOutput.trim();
    return {
      gitCommit: committed ? headOutput.trim() : null,
      gitBlob: blobOutput.trim() || null,
      gitStatus: committed ? 'committed' as const : 'uncommitted' as const,
    };
  } catch {
    return { gitCommit: null, gitBlob: null, gitStatus: 'unavailable' as const };
  }
}

async function collectMarkdown(vaultRoot: string) {
  const issues: ScanIssue[] = [];
  const candidates: Candidate[] = [];
  const rootStat = await lstat(vaultRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new WorkDbError('Wiki Vault 루트는 실제 디렉터리여야 합니다.', 409, 'WIKI_VAULT_INVALID');
  const resolvedVault = await realpath(vaultRoot);

  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relativePath = posixRelative(vaultRoot, absolute);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        issues.push({ severity: 'error', code: 'SYMLINK_BLOCKED', relativePath, docId: null, detail: 'symlink/junction 항목은 스캔하지 않습니다.' });
        continue;
      }
      if (metadata.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!metadata.isFile() || path.extname(entry.name).toLowerCase() !== '.md') continue;
      if (metadata.size > MAX_MARKDOWN_BYTES) {
        issues.push({ severity: 'error', code: 'FILE_TOO_LARGE', relativePath, docId: null, detail: `파일이 ${MAX_MARKDOWN_BYTES} bytes를 초과합니다.` });
        continue;
      }
      const resolvedFile = await realpath(absolute);
      if (!pathIsInside(resolvedVault, resolvedFile)) {
        issues.push({ severity: 'error', code: 'PATH_ESCAPE_BLOCKED', relativePath, docId: null, detail: 'Vault 밖의 실경로를 가리킵니다.' });
        continue;
      }
      const bytes = await readFile(resolvedFile);
      try {
        const parsed = parseWikiMarkdown(bytes);
        const byteHash = sha256(bytes);
        const historyObjectPath = await writeHistoryObject(vaultRoot, byteHash, bytes);
        const git = await gitMetadata(vaultRoot, resolvedFile, relativePath);
        candidates.push({
          relativePath,
          byteHash,
          textHash: sha256(parsed.normalized),
          fileSize: bytes.length,
          mtimeMs: Math.trunc(metadata.mtimeMs),
          frontmatter: parsed.frontmatter,
          historyObjectPath,
          ...git,
        });
      } catch (error) {
        issues.push({ severity: 'error', code: 'FRONTMATTER_INVALID', relativePath, docId: null, detail: error instanceof Error ? error.message : 'Markdown 파싱 실패' });
      }
    }
  }

  for (const directory of [...ACTIVE_DIRECTORIES].sort()) {
    const candidate = path.join(vaultRoot, directory);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) issues.push({ severity: 'error', code: 'SYMLINK_BLOCKED', relativePath: directory, docId: null, detail: '활성 Wiki 디렉터리가 symlink/junction입니다.' });
      else if (metadata.isDirectory()) await walk(candidate);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { candidates, issues };
}

function entityExists(db: DatabaseSync, candidate: Candidate) {
  if (candidate.frontmatter.document_type !== 'entity_wiki') return true;
  const table = ENTITY_TABLES[candidate.frontmatter.entity_type!];
  return Boolean(db.prepare(`SELECT id FROM ${table} WHERE id=? AND archived_at IS NULL`).get(candidate.frontmatter.entity_id!));
}

function insertIssue(db: DatabaseSync, scanId: string, issue: ScanIssue, timestamp: string) {
  db.prepare(`INSERT INTO wiki_markdown_scan_issue(id,scan_id,severity,code,relative_path,doc_id,detail,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(randomUUID(), scanId, issue.severity, issue.code, issue.relativePath, issue.docId, issue.detail.slice(0, 2000), timestamp);
}

export async function scanWikiMarkdownVault() {
  const vaultRoot = resolveWikiVaultPath();
  try {
    await access(vaultRoot, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new WorkDbError('Wiki Vault를 읽고 이력을 기록할 수 없습니다.', 409, 'WIKI_VAULT_UNAVAILABLE');
  }
  const startedAt = new Date().toISOString();
  const scanId = randomUUID();
  const { candidates, issues } = await collectMarkdown(vaultRoot);
  const duplicates = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = duplicates.get(candidate.frontmatter.doc_id) ?? [];
    list.push(candidate);
    duplicates.set(candidate.frontmatter.doc_id, list);
  }
  for (const [docId, list] of duplicates) {
    if (list.length < 2) continue;
    for (const candidate of list) issues.push({ severity: 'error', code: 'DUPLICATE_DOC_ID', relativePath: candidate.relativePath, docId, detail: `${docId}가 ${list.length}개 파일에 있습니다.` });
  }

  return withDatabase((db) => transaction(db, () => {
    const timestamp = new Date().toISOString();
    const vaultFingerprint = sha256(path.resolve(vaultRoot).toLowerCase());
    db.prepare(`INSERT INTO wiki_markdown_scan(id,profile,vault_fingerprint,status,started_at) VALUES (?,?,?,'running',?)`)
      .run(scanId, runtimeProfile(), vaultFingerprint, startedAt);
    let indexedCount = 0;

    for (const candidate of candidates) {
      const docId = candidate.frontmatter.doc_id;
      if ((duplicates.get(docId)?.length ?? 0) > 1) {
        db.prepare(`UPDATE wiki_document SET parse_status='duplicate',last_seen_scan_id=?,updated_at=? WHERE doc_id=?`).run(scanId, timestamp, docId);
        continue;
      }
      const existing = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(docId) as Record<string, any> | undefined;
      if (existing && (
        existing.document_type !== candidate.frontmatter.document_type
        || (existing.entity_type ?? null) !== (candidate.frontmatter.entity_type ?? null)
        || (existing.entity_id ?? null) !== (candidate.frontmatter.entity_id ?? null)
      )) {
        issues.push({ severity: 'error', code: 'ENTITY_BINDING_CHANGED', relativePath: candidate.relativePath, docId, detail: '기존 doc_id의 문서/엔티티 연결 변경을 거부했습니다.' });
        db.prepare(`UPDATE wiki_document SET parse_status='binding_conflict',last_seen_scan_id=?,updated_at=? WHERE doc_id=?`).run(scanId, timestamp, docId);
        continue;
      }
      if (!entityExists(db, candidate)) {
        issues.push({ severity: 'error', code: 'ENTITY_NOT_FOUND', relativePath: candidate.relativePath, docId, detail: 'DB에서 연결 대상 엔티티를 찾을 수 없습니다.' });
        if (existing) db.prepare(`UPDATE wiki_document SET parse_status='entity_missing',last_seen_scan_id=?,updated_at=? WHERE doc_id=?`).run(scanId, timestamp, docId);
        continue;
      }
      const pathOwner = db.prepare('SELECT doc_id FROM wiki_document WHERE relative_path=? AND doc_id<>?').get(candidate.relativePath, docId) as { doc_id?: string } | undefined;
      if (pathOwner?.doc_id) {
        issues.push({ severity: 'error', code: 'PATH_OWNERSHIP_CONFLICT', relativePath: candidate.relativePath, docId, detail: `경로가 다른 문서 ${pathOwner.doc_id}에 연결되어 있습니다.` });
        continue;
      }

      const changed = !existing || existing.byte_hash !== candidate.byteHash || existing.relative_path !== candidate.relativePath;
      let currentRevisionId = existing?.current_revision_id ?? null;
      if (!existing) {
        db.prepare(`INSERT INTO wiki_document(doc_id,document_type,entity_type,entity_id,title,relative_path,byte_hash,text_hash,file_size,file_mtime_ms,parse_status,last_seen_scan_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'valid',?,?,?)`)
          .run(docId, candidate.frontmatter.document_type, candidate.frontmatter.entity_type ?? null, candidate.frontmatter.entity_id ?? null, candidate.frontmatter.title, candidate.relativePath, candidate.byteHash, candidate.textHash, candidate.fileSize, candidate.mtimeMs, scanId, timestamp, timestamp);
      }
      if (changed) {
        const revision = db.prepare('SELECT COALESCE(MAX(revision_number),0)+1 AS version FROM wiki_markdown_revision WHERE doc_id=?').get(docId) as { version: number };
        currentRevisionId = randomUUID();
        db.prepare(`INSERT INTO wiki_markdown_revision(id,doc_id,revision_number,parent_revision_id,scan_id,relative_path,byte_hash,text_hash,file_size,history_object_path,git_commit,git_blob,git_status,origin,observed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'human_observed',?)`)
          .run(currentRevisionId, docId, Number(revision.version), existing?.current_revision_id ?? null, scanId, candidate.relativePath, candidate.byteHash, candidate.textHash, candidate.fileSize, candidate.historyObjectPath, candidate.gitCommit, candidate.gitBlob, candidate.gitStatus, timestamp);
      }
      db.prepare(`UPDATE wiki_document SET title=?,relative_path=?,byte_hash=?,text_hash=?,file_size=?,file_mtime_ms=?,parse_status='valid',current_revision_id=?,last_seen_scan_id=?,updated_at=? WHERE doc_id=?`)
        .run(candidate.frontmatter.title, candidate.relativePath, candidate.byteHash, candidate.textHash, candidate.fileSize, candidate.mtimeMs, currentRevisionId, scanId, timestamp, docId);
      indexedCount += 1;
    }

    db.prepare(`UPDATE wiki_document SET parse_status='missing',updated_at=? WHERE last_seen_scan_id<>? OR last_seen_scan_id IS NULL`).run(timestamp, scanId);
    for (const issue of issues) insertIssue(db, scanId, issue, timestamp);
    const snapshotHash = sha256(JSON.stringify(candidates.map((candidate) => [candidate.relativePath, candidate.frontmatter.doc_id, candidate.byteHash]).sort((left, right) => left[0].localeCompare(right[0]))));
    db.prepare(`UPDATE wiki_markdown_scan SET status='succeeded',discovered_count=?,indexed_count=?,issue_count=?,snapshot_hash=?,completed_at=? WHERE id=?`)
      .run(candidates.length, indexedCount, issues.length, snapshotHash, timestamp, scanId);
    return { scanId, status: 'succeeded', discoveredCount: candidates.length, indexedCount, issueCount: issues.length, snapshotHash };
  }));
}

export function wikiMarkdownIndex() {
  return withDatabase((db) => ({
    documents: db.prepare(`SELECT doc_id AS docId,document_type AS documentType,entity_type AS entityType,entity_id AS entityId,title,relative_path AS relativePath,byte_hash AS byteHash,text_hash AS textHash,file_size AS fileSize,file_mtime_ms AS fileMtimeMs,parse_status AS parseStatus,current_revision_id AS currentRevisionId,updated_at AS updatedAt FROM wiki_document ORDER BY title,doc_id`).all(),
    latestScan: db.prepare(`SELECT id AS scanId,profile,status,discovered_count AS discoveredCount,indexed_count AS indexedCount,issue_count AS issueCount,snapshot_hash AS snapshotHash,started_at AS startedAt,completed_at AS completedAt FROM wiki_markdown_scan ORDER BY started_at DESC LIMIT 1`).get() ?? null,
  }));
}

export async function readWikiMarkdownSource(docId: string) {
  const indexed = withDatabase((db) => {
    const document = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(docId) as Record<string, any> | undefined;
    if (!document) throw new WorkDbError('Markdown Wiki 문서를 찾을 수 없습니다.', 404, 'WIKI_MARKDOWN_NOT_FOUND');
    if (document.parse_status !== 'valid') throw new WorkDbError('유효한 최신 Markdown Wiki 문서가 필요합니다.', 409, 'WIKI_MARKDOWN_NOT_VALID');
    const revision = document.current_revision_id
      ? db.prepare('SELECT * FROM wiki_markdown_revision WHERE id=?').get(document.current_revision_id) as Record<string, any> | undefined
      : undefined;
    return { document, revision: revision ?? null };
  });
  const vaultRoot = resolveWikiVaultPath();
  const vaultStat = await lstat(vaultRoot);
  if (!vaultStat.isDirectory() || vaultStat.isSymbolicLink()) throw new WorkDbError('Wiki Vault 루트는 실제 디렉터리여야 합니다.', 409, 'WIKI_VAULT_INVALID');
  const resolvedVault = await realpath(vaultRoot);
  const target = path.resolve(vaultRoot, ...String(indexed.document.relative_path).split('/'));
  let resolvedTarget: string;
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('실제 Markdown 파일이 아닙니다.');
    resolvedTarget = await realpath(target);
  } catch {
    throw new WorkDbError('Markdown Wiki 원본 파일이 없습니다.', 409, 'WIKI_MARKDOWN_SOURCE_MISSING');
  }
  if (!pathIsInside(resolvedVault, resolvedTarget)) throw new WorkDbError('Wiki 문서 경로가 Vault를 벗어났습니다.', 409, 'WIKI_PATH_ESCAPE_BLOCKED');
  const bytes = await readFile(resolvedTarget);
  const parsed = parseWikiMarkdown(bytes);
  if (parsed.frontmatter.doc_id !== docId) throw new WorkDbError('파일의 doc_id가 인덱스와 다릅니다.', 409, 'WIKI_IDENTITY_MISMATCH');
  const byteHash = sha256(bytes);
  return {
    ...indexed,
    vaultRoot,
    absolutePath: resolvedTarget,
    bytes,
    byteHash,
    textHash: sha256(parsed.normalized),
    indexStale: byteHash !== indexed.document.byte_hash,
    frontmatter: parsed.frontmatter,
    markdown: parsed.body,
    normalized: parsed.normalized,
  };
}

export async function wikiMarkdownDetail(docId: string) {
  const document = withDatabase((db) => {
    const row = db.prepare('SELECT * FROM wiki_document WHERE doc_id=?').get(docId) as Record<string, any> | undefined;
    if (!row) throw new WorkDbError('Markdown Wiki 문서를 찾을 수 없습니다.', 404, 'WIKI_MARKDOWN_NOT_FOUND');
    const revisions = db.prepare(`SELECT id,revision_number AS revisionNumber,parent_revision_id AS parentRevisionId,relative_path AS relativePath,byte_hash AS byteHash,text_hash AS textHash,file_size AS fileSize,history_object_path AS historyObjectPath,git_commit AS gitCommit,git_blob AS gitBlob,git_status AS gitStatus,origin,observed_at AS observedAt FROM wiki_markdown_revision WHERE doc_id=? ORDER BY revision_number DESC`).all(docId);
    return { row, revisions };
  });
  if (document.row.parse_status === 'missing') return { document: document.row, revisions: document.revisions, missing: true, indexStale: true, markdown: null };
  const vaultRoot = resolveWikiVaultPath();
  const target = path.resolve(vaultRoot, ...String(document.row.relative_path).split('/'));
  const resolvedVault = await realpath(vaultRoot);
  let resolvedTarget: string;
  try {
    const targetStat = await lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('실제 Markdown 파일이 아닙니다.');
    resolvedTarget = await realpath(target);
  } catch {
    return { document: document.row, revisions: document.revisions, missing: true, indexStale: true, markdown: null };
  }
  if (!pathIsInside(resolvedVault, resolvedTarget)) throw new WorkDbError('Wiki 문서 경로가 Vault를 벗어났습니다.', 409, 'WIKI_PATH_ESCAPE_BLOCKED');
  const bytes = await readFile(resolvedTarget);
  const parsed = parseWikiMarkdown(bytes);
  if (parsed.frontmatter.doc_id !== docId) throw new WorkDbError('파일의 doc_id가 인덱스와 다릅니다.', 409, 'WIKI_IDENTITY_MISMATCH');
  const byteHash = sha256(bytes);
  return {
    document: document.row,
    revisions: document.revisions,
    missing: false,
    indexStale: byteHash !== document.row.byte_hash,
    currentByteHash: byteHash,
    frontmatter: parsed.frontmatter,
    markdown: parsed.body,
  };
}

export function wikiMarkdownScanIssues(scanId: string) {
  return withDatabase((db) => db.prepare(`SELECT severity,code,relative_path AS relativePath,doc_id AS docId,detail,created_at AS createdAt FROM wiki_markdown_scan_issue WHERE scan_id=? ORDER BY severity DESC,relative_path,code`).all(scanId));
}
