import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { pathIsInside, runtimeProfile } from './runtime-environment';
import { transaction, withDatabase, WorkDbError } from './work-db';

type Row = Record<string, any>;
type MigrationItem = {
  itemId: string;
  sourceKind: 'published_revision' | 'pending_draft' | 'rejected_draft';
  sourceId: string;
  entityType: string;
  entityId: string;
  docId: string;
  sourceHash: string;
  outputRelativePath: string;
  outputByteHash: string;
  sentenceCount: number;
  evidenceCount: number;
  sourceCreatedAt: string;
  validationStatus: 'valid' | 'invalid' | 'conflict';
  detail: string | null;
};

const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
function check(condition: unknown, message: string, status = 400, code = 'WIKI_MIGRATION_VALIDATION'): asserts condition {
  if (!condition) throw new WorkDbError(message, status, code);
}
function row(db: DatabaseSync, sql: string, ...params: any[]) {
  return db.prepare(sql).get(...params) as Row | undefined;
}
function posix(value: string) { return value.split(path.sep).join('/'); }

function documentIdentity(entityType: string, entityId: string) {
  return `wiki-legacy-${hash(`${entityType}:${entityId}`).slice(0, 24)}`;
}

function entityTitle(db: DatabaseSync, entityType: string, entityId: string) {
  const definitions: Record<string, { table: string; column: string; directory: string }> = {
    matter: { table: 'matter', column: 'our_ref', directory: '10_Matters' },
    organization: { table: 'organization', column: 'name', directory: '20_Organizations' },
    person: { table: 'person', column: 'name', directory: '30_People' },
    group: { table: 'matter_group', column: 'group_ref', directory: '40_Groups' },
  };
  const definition = definitions[entityType];
  if (!definition) return { title: `${entityType} ${entityId}`, directory: '90_Archive', valid: false };
  const entity = row(db, `SELECT ${definition.column} AS title FROM ${definition.table} WHERE id=?`, entityId);
  return { title: String(entity?.title ?? `${entityType} ${entityId}`).replace(/[\r\n]+/g, ' ').trim(), directory: definition.directory, valid: Boolean(entity) };
}

function safeFilename(title: string, docId: string) {
  const withoutControl = [...title].map((character) => character.charCodeAt(0) < 32 ? '-' : character).join('');
  const base = withoutControl.replace(/[<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'untitled';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? `_${base}` : base;
  return `${reserved}--${docId.slice(-8)}.md`;
}

function parseSections(value: unknown) {
  try {
    const sections = JSON.parse(String(value));
    if (!Array.isArray(sections) || sections.length === 0) throw new Error('sections가 비어 있습니다.');
    return sections as Array<{ key?: string; title?: string; sentences?: Array<{ text?: string; entryDate?: string | null; eventIds?: string[] }> }>;
  } catch (error) {
    throw new WorkDbError(`레거시 sections_json 파싱 실패: ${error instanceof Error ? error.message : String(error)}`, 409, 'WIKI_MIGRATION_SOURCE_INVALID');
  }
}

function renderMarkdown(entityType: string, entityId: string, title: string, docId: string, sectionsJson: unknown, proposal: boolean) {
  const sections = parseSections(sectionsJson);
  const lines = [
    '---',
    'schema_version: wiki-md-v1',
    `doc_id: ${docId}`,
    'document_type: entity_wiki',
    `entity_type: ${entityType}`,
    `entity_id: ${JSON.stringify(entityId)}`,
    `title: ${JSON.stringify(title)}`,
    'tags: [migration, legacy]',
    '---',
    '',
    `# ${title}`,
    '',
  ];
  if (proposal) lines.push('> 이 파일은 레거시 미게시 초안의 dry-run 변환본이며 활성 Wiki가 아닙니다.', '');
  const footnotes: string[] = [];
  const citedEventIds: string[] = [];
  let sentenceCount = 0;
  let evidenceCount = 0;
  for (const [sectionIndex, section] of sections.entries()) {
    check(typeof section.title === 'string' && section.title.trim(), '레거시 단락 제목이 없습니다.', 409, 'WIKI_MIGRATION_SOURCE_INVALID');
    check(Array.isArray(section.sentences), '레거시 단락 문장 목록 오류', 409, 'WIKI_MIGRATION_SOURCE_INVALID');
    lines.push(`## ${section.title.trim()}`, '');
    for (const [sentenceIndex, sentence] of section.sentences.entries()) {
      check(typeof sentence.text === 'string' && sentence.text.trim(), '레거시 문장이 비어 있습니다.', 409, 'WIKI_MIGRATION_SOURCE_INVALID');
      const eventIds = Array.isArray(sentence.eventIds) ? sentence.eventIds.map(String) : [];
      citedEventIds.push(...eventIds);
      const refs = eventIds.map((eventId, eventIndex) => {
        const ref = `ev-${sectionIndex + 1}-${sentenceIndex + 1}-${eventIndex + 1}`;
        footnotes.push(`[^${ref}]: event:${eventId}`);
        return `[^${ref}]`;
      }).join('');
      const datePrefix = sentence.entryDate ? `${sentence.entryDate} ` : '';
      lines.push(`- ${datePrefix}${sentence.text.trim()}${refs}`);
      sentenceCount += 1;
      evidenceCount += eventIds.length;
    }
    lines.push('');
  }
  if (footnotes.length) lines.push(...footnotes, '');
  const markdown = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  return { markdown, sentenceCount, evidenceCount, eventIds: [...new Set(citedEventIds)].sort() };
}

function migrationSources(db: DatabaseSync) {
  const revisions = db.prepare(`SELECT id,entity_type,entity_id,version,run_id,sections_json,change_summary,input_hash,publication_event_id,created_at FROM entity_wiki_revision ORDER BY entity_type,entity_id,version`).all() as Row[];
  const drafts = db.prepare(`SELECT run_id,entity_type,entity_id,base_version,sections_json,change_summary,review_status,created_at FROM wiki_draft WHERE review_status IN ('pending','rejected') ORDER BY entity_type,entity_id,created_at,run_id`).all() as Row[];
  return { revisions, drafts };
}

function recordMigration(manifest: Row, manifestHash: string, outputRoot: string, duplicate: boolean) {
  return withDatabase((db) => transaction(db, () => {
    const existing = row(db, 'SELECT * FROM wiki_migration_run WHERE id=?', manifest.runId);
    if (existing) {
      check(existing.output_manifest_hash === manifestHash, '기존 이관 원장과 manifest가 다릅니다.', 409, 'WIKI_MIGRATION_LEDGER_CONFLICT');
      return { run: existing, manifest, duplicate: true };
    }
    const timestamp = String(manifest.createdAt);
    db.prepare(`INSERT INTO wiki_file_operation(id,operation_type,subject_id,status,target_byte_hash,relative_path,created_at,updated_at) VALUES (?,'migration_dry_run',?,'succeeded',?,?,?,?)`)
      .run(`wiki-operation-${hash(manifest.runId).slice(0, 24)}`, manifest.runId, manifestHash, posix(path.relative(path.resolve(process.env.SSPAT_ISOLATED_ROOT!), outputRoot)), timestamp, timestamp);
    db.prepare(`INSERT INTO wiki_migration_run(id,conversion_version,source_snapshot_hash,output_root,output_manifest_hash,status,revision_count,draft_count,created_at,completed_at) VALUES (?,?,?,?,?,'succeeded',?,?,?,?)`)
      .run(manifest.runId, manifest.conversionVersion, manifest.sourceSnapshotHash, outputRoot, manifestHash, manifest.summary.publishedRevisionCount, manifest.summary.draftCount, timestamp, timestamp);
    const insert = db.prepare(`INSERT INTO wiki_migration_item(id,migration_run_id,source_kind,source_id,entity_type,entity_id,doc_id,source_hash,output_relative_path,output_byte_hash,sentence_count,evidence_count,source_created_at,validation_status,detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of manifest.items as MigrationItem[]) {
      insert.run(item.itemId, manifest.runId, item.sourceKind, item.sourceId, item.entityType, item.entityId, item.docId, item.sourceHash, item.outputRelativePath, item.outputByteHash, item.sentenceCount, item.evidenceCount, item.sourceCreatedAt, item.validationStatus, item.detail);
    }
    return { run: row(db, 'SELECT * FROM wiki_migration_run WHERE id=?', manifest.runId), manifest, duplicate };
  }));
}

function verifyExistingOutput(outputRoot: string, expected: { runId: string; conversionVersion: string; sourceSnapshotHash: string; outputRootFingerprint: string }) {
  const manifestFile = path.join(outputRoot, 'migration-manifest.json');
  const resolvedOutput = realpathSync(outputRoot);
  check(existsSync(manifestFile) && lstatSync(manifestFile).isFile() && !lstatSync(manifestFile).isSymbolicLink() && pathIsInside(resolvedOutput, realpathSync(manifestFile)), '기존 출력 폴더에 유효한 migration-manifest.json이 없습니다.', 409, 'WIKI_MIGRATION_OUTPUT_CONFLICT');
  const bytes = readFileSync(manifestFile);
  const manifest = JSON.parse(bytes.toString('utf8')) as Row;
  check(
    manifest.schema === 'wiki-legacy-migration-v1'
      && manifest.runId === expected.runId
      && manifest.conversionVersion === expected.conversionVersion
      && manifest.sourceSnapshotHash === expected.sourceSnapshotHash
      && manifest.outputRootFingerprint === expected.outputRootFingerprint,
    '기존 이관 출력이 현재 입력 또는 출력 경로와 다릅니다.',
    409,
    'WIKI_MIGRATION_OUTPUT_CONFLICT',
  );
  for (const item of [...(manifest.items ?? []), ...(manifest.activeCandidates ?? [])] as Row[]) {
    const target = path.resolve(outputRoot, ...String(item.outputRelativePath).split('/'));
    check(pathIsInside(outputRoot, target) && existsSync(target) && lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink() && pathIsInside(resolvedOutput, realpathSync(target)), '기존 이관 산출물이 누락되었거나 출력 경로를 벗어났습니다.', 409, 'WIKI_MIGRATION_OUTPUT_CONFLICT');
    check(hash(readFileSync(target)) === item.outputByteHash, '기존 이관 산출물 hash가 다릅니다.', 409, 'WIKI_MIGRATION_OUTPUT_CONFLICT');
  }
  return { manifest, manifestHash: hash(bytes) };
}

export function runLegacyWikiMigrationDryRun(outputRootInput: string, conversionVersion = 'legacy-wiki-md-v1') {
  check(runtimeProfile() !== 'operational', '운영 프로필에서는 레거시 Wiki dry-run을 실행할 수 없습니다.', 409, 'WIKI_MIGRATION_OPERATIONAL_BLOCKED');
  const isolatedRoot = path.resolve(String(process.env.SSPAT_ISOLATED_ROOT ?? ''));
  check(Boolean(process.env.SSPAT_ISOLATED_ROOT), 'SSPAT_ISOLATED_ROOT가 필요합니다.', 409);
  const outputRoot = path.resolve(outputRootInput);
  check(pathIsInside(isolatedRoot, outputRoot) && outputRoot !== isolatedRoot, '이관 출력은 격리 루트의 하위 폴더여야 합니다.', 409, 'WIKI_MIGRATION_PATH_BLOCKED');
  const parent = path.dirname(outputRoot);
  check(existsSync(parent) && lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), '이관 출력의 상위 폴더가 실제 디렉터리여야 합니다.', 409, 'WIKI_MIGRATION_PATH_BLOCKED');
  check(pathIsInside(realpathSync(isolatedRoot), realpathSync(parent)), '이관 출력 경로가 격리 루트를 벗어났습니다.', 409, 'WIKI_MIGRATION_PATH_BLOCKED');
  check(typeof conversionVersion === 'string' && /^[a-z0-9][a-z0-9._-]{2,99}$/.test(conversionVersion), 'conversionVersion 형식 오류');

  const prepared = withDatabase((db) => {
    const { revisions, drafts } = migrationSources(db);
    const sourceRefs = [
      ...revisions.map((item) => ['published_revision', item.id, hash(item)]),
      ...drafts.map((item) => [item.review_status === 'pending' ? 'pending_draft' : 'rejected_draft', item.run_id, hash(item)]),
    ];
    const sourceSnapshotHash = hash(sourceRefs);
    const files = new Map<string, Buffer>();
    const items: MigrationItem[] = [];
    const activeCandidates: Row[] = [];
    const latest = new Map<string, Row>();

    const convert = (sourceKind: MigrationItem['sourceKind'], sourceId: string, item: Row, proposal: boolean) => {
      const identity = documentIdentity(item.entity_type, item.entity_id);
      const target = entityTitle(db, item.entity_type, item.entity_id);
      let rendered: ReturnType<typeof renderMarkdown>;
      let validationStatus: MigrationItem['validationStatus'] = target.valid ? 'valid' : 'invalid';
      let detail: string | null = target.valid ? null : '대상 엔티티가 현재 DB에 없습니다.';
      try {
        rendered = renderMarkdown(item.entity_type, item.entity_id, target.title, identity, item.sections_json, proposal);
        const invalidEvidence = rendered.eventIds.filter((eventId) => {
          const event = row(db, 'SELECT entity_type,entity_id FROM event WHERE id=?', eventId);
          return !event || event.entity_type !== item.entity_type || event.entity_id !== item.entity_id;
        });
        if (rendered.evidenceCount === 0 || invalidEvidence.length > 0) {
          validationStatus = 'invalid';
          detail = rendered.evidenceCount === 0 ? '문장별 근거 이벤트가 없습니다.' : `누락되었거나 다른 엔티티의 근거 이벤트: ${invalidEvidence.join(', ')}`;
        }
      } catch (error) {
        rendered = { markdown: `# 변환 실패\n\n${error instanceof Error ? error.message : String(error)}\n`, sentenceCount: 0, evidenceCount: 0, eventIds: [] };
        validationStatus = 'invalid';
        detail = error instanceof Error ? error.message : String(error);
      }
      const revisionName = sourceKind === 'published_revision' ? `revision-${String(item.version).padStart(6, '0')}` : `${sourceKind}-${sourceId}`;
      const relative = proposal
        ? `artifacts/proposals/${identity}/${revisionName}.md`
        : `artifacts/history/${identity}/${revisionName}.md`;
      const bytes = Buffer.from(rendered.markdown, 'utf8');
      check(!files.has(relative), '이관 출력 경로가 중복되었습니다.', 409, 'WIKI_MIGRATION_OUTPUT_CONFLICT');
      files.set(relative, bytes);
      items.push({
        itemId: `wiki-migration-item-${hash(`${sourceKind}:${sourceId}`).slice(0, 24)}`,
        sourceKind,
        sourceId,
        entityType: item.entity_type,
        entityId: item.entity_id,
        docId: identity,
        sourceHash: hash(item),
        outputRelativePath: relative,
        outputByteHash: hash(bytes),
        sentenceCount: rendered.sentenceCount,
        evidenceCount: rendered.evidenceCount,
        sourceCreatedAt: item.created_at,
        validationStatus,
        detail,
      });
      return { identity, target, bytes, rendered, valid: validationStatus === 'valid' };
    };

    for (const revision of revisions) {
      const converted = convert('published_revision', revision.id, revision, false);
      const key = `${revision.entity_type}:${revision.entity_id}`;
      const previous = latest.get(key);
      if (!previous || Number(revision.version) > Number(previous.version)) latest.set(key, { ...revision, ...converted });
    }
    for (const draft of drafts) convert(draft.review_status === 'pending' ? 'pending_draft' : 'rejected_draft', draft.run_id, draft, true);
    for (const current of latest.values()) {
      if (!current.valid) continue;
      const activeRelative = `artifacts/active/${current.target.directory}/${safeFilename(current.target.title, current.identity)}`;
      check(!files.has(activeRelative), '활성 후보 출력 경로가 중복되었습니다.', 409, 'WIKI_MIGRATION_OUTPUT_CONFLICT');
      files.set(activeRelative, current.bytes);
      activeCandidates.push({
        docId: current.identity,
        entityType: current.entity_type,
        entityId: current.entity_id,
        sourceRevisionId: current.id,
        suggestedVaultPath: `${current.target.directory}/${safeFilename(current.target.title, current.identity)}`,
        outputRelativePath: activeRelative,
        outputByteHash: hash(current.bytes),
      });
    }
    return { revisions, drafts, sourceSnapshotHash, files, items, activeCandidates };
  });

  const outputRootFingerprint = hash(outputRoot.toLowerCase());
  const runId = `wiki-migration-${hash(`${conversionVersion}:${prepared.sourceSnapshotHash}:${outputRoot.toLowerCase()}`).slice(0, 24)}`;
  if (existsSync(outputRoot)) {
    const outputInfo = lstatSync(outputRoot);
    check(outputInfo.isDirectory() && !outputInfo.isSymbolicLink() && pathIsInside(realpathSync(isolatedRoot), realpathSync(outputRoot)), '기존 이관 출력이 격리 루트의 실제 폴더가 아닙니다.', 409, 'WIKI_MIGRATION_PATH_BLOCKED');
    const existing = verifyExistingOutput(outputRoot, { runId, conversionVersion, sourceSnapshotHash: prepared.sourceSnapshotHash, outputRootFingerprint });
    return recordMigration(existing.manifest, existing.manifestHash, outputRoot, true);
  }

  const createdAt = now();
  const manifestItems = prepared.items.map((item) => ({
    ...item,
    itemId: `wiki-migration-item-${hash(`${runId}:${item.sourceKind}:${item.sourceId}`).slice(0, 24)}`,
  }));
  const manifest: Row = {
    schema: 'wiki-legacy-migration-v1',
    runId,
    conversionVersion,
    dryRun: true,
    sourceSnapshotHash: prepared.sourceSnapshotHash,
    outputRootFingerprint,
    createdAt,
    summary: {
      publishedRevisionCount: prepared.revisions.length,
      draftCount: prepared.drafts.length,
      activeCandidateCount: prepared.activeCandidates.length,
      invalidItemCount: prepared.items.filter((item) => item.validationStatus !== 'valid').length,
    },
    items: manifestItems,
    activeCandidates: prepared.activeCandidates,
    guarantees: {
      legacyRowsModified: false,
      activeVaultModified: false,
      pendingDraftPromoted: false,
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const manifestHash = hash(manifestBytes);
  const staging = path.join(parent, `.wiki-migration-staging-${runId}`);
  check(pathIsInside(isolatedRoot, staging), '이관 staging 경로 오류', 409, 'WIKI_MIGRATION_PATH_BLOCKED');
  check(!existsSync(staging), '기존 staging 폴더를 덮어쓰지 않습니다.', 409, 'WIKI_MIGRATION_OUTPUT_CONFLICT');
  mkdirSync(staging);
  try {
    for (const [relative, bytes] of prepared.files) {
      const target = path.resolve(staging, ...relative.split('/'));
      check(pathIsInside(staging, target), '이관 산출물 경로 탈출', 409, 'WIKI_MIGRATION_PATH_BLOCKED');
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
    }
    writeFileSync(path.join(staging, 'migration-manifest.json'), manifestBytes, { flag: 'wx' });
    renameSync(staging, outputRoot);
  } catch (error) {
    if (existsSync(staging)) {
      const stagingInfo = lstatSync(staging);
      if (stagingInfo.isDirectory() && !stagingInfo.isSymbolicLink()) rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
  return recordMigration(manifest, manifestHash, outputRoot, false);
}

export function wikiMigrationRun(runId: string) {
  return withDatabase((db) => {
    const run = row(db, 'SELECT * FROM wiki_migration_run WHERE id=?', runId);
    check(run, 'Wiki 이관 실행을 찾을 수 없습니다.', 404);
    return { run, items: db.prepare('SELECT * FROM wiki_migration_item WHERE migration_run_id=? ORDER BY source_kind,entity_type,entity_id,source_created_at').all(runId) };
  });
}
