import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseWikiMarkdown,
  scanWikiMarkdownVault,
  wikiMarkdownDetail,
  wikiMarkdownIndex,
  wikiMarkdownScanIssues,
} from '../lib/wiki-markdown';
import { withDatabase } from '../lib/work-db';

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-markdown-'));
const vaultRoot = path.join(temporaryRoot, 'vault');
const matterDirectory = path.join(vaultRoot, '10_Matters');
const noteDirectory = path.join(vaultRoot, '60_Notes');
const databaseFile = path.join(temporaryRoot, 'db', 'work.db');

process.env.SSPAT_RUNTIME_PROFILE = 'test';
process.env.SSPAT_ISOLATED_ROOT = temporaryRoot;
process.env.SSPAT_WORK_DB_PATH = databaseFile;
process.env.SSPAT_WIKI_VAULT_PATH = vaultRoot;
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));

function matterMarkdown(body: string, entityId = 'eval-matter-001') {
  return `---\nschema_version: wiki-md-v1\ndoc_id: wiki-eval-matter-001\ndocument_type: entity_wiki\nentity_type: matter\nentity_id: ${entityId}\ntitle: 합성 사건 검토\ntags: [eval, synthetic]\n---\n\n${body}\n`;
}

async function main() {
  try {
    mkdirSync(matterDirectory, { recursive: true });
    mkdirSync(noteDirectory, { recursive: true });
    withDatabase((db) => {
      const timestamp = '2026-09-22T00:00:00.000Z';
      db.prepare(`INSERT INTO matter(id,our_ref,office,matter_kind,country_code,base_ref,suffixes_json,source_type,confidence,user_confirmed,created_at,updated_at) VALUES (?,'P260001-CN(PA)','상상특허','foreign_provisional','CN','P260001','["CN","PA"]','user_input',1,1,?,?)`)
        .run('eval-matter-001', timestamp, timestamp);
    });

    const matterFile = path.join(matterDirectory, 'P260001-CN-PA.md');
    writeFileSync(matterFile, matterMarkdown('# 사건 검토\n\n최초 본문입니다.'), 'utf8');
    writeFileSync(path.join(noteDirectory, 'README.md'), `---\nschema_version: wiki-md-v1\ndoc_id: wiki-eval-note-001\ndocument_type: note\ntitle: 합성 자유 노트\n---\n\n# 자유 노트\n`, 'utf8');

    assert.throws(
      () => parseWikiMarkdown(Buffer.from(`---\nschema_version: wiki-md-v1\ndoc_id: wiki-bad-001\ndocument_type: note\ntitle: 잘못된 문서\napproved: true\n---\n`)),
      /approved 필드는 허용되지 않습니다/,
    );

    const first = await scanWikiMarkdownVault();
    assert.equal(first.indexedCount, 2);
    assert.equal(first.issueCount, 0);
    const firstIndex: any = wikiMarkdownIndex();
    assert.equal(firstIndex.documents.length, 2);
    assert.equal(firstIndex.documents.find((item: any) => item.docId === 'wiki-eval-matter-001').parseStatus, 'valid');
    const firstDetail: any = await wikiMarkdownDetail('wiki-eval-matter-001');
    assert.equal(firstDetail.indexStale, false);
    assert.match(firstDetail.markdown, /최초 본문/);
    assert.equal(firstDetail.revisions.length, 1);
    const historyFile = path.join(vaultRoot, ...firstDetail.revisions[0].historyObjectPath.split('/'));
    assert.equal(readFileSync(historyFile, 'utf8'), readFileSync(matterFile, 'utf8'));

    withDatabase((db) => {
      const documentColumns = db.prepare('PRAGMA table_info(wiki_document)').all() as Array<{ name: string }>;
      const revisionColumns = db.prepare('PRAGMA table_info(wiki_markdown_revision)').all() as Array<{ name: string }>;
      const forbidden = /^(body|content|sections_json|markdown)$/;
      assert.equal(documentColumns.some((column) => forbidden.test(column.name)), false);
      assert.equal(revisionColumns.some((column) => forbidden.test(column.name)), false);
    });

    writeFileSync(matterFile, matterMarkdown('# 사건 검토\n\n사람이 수정한 두 번째 본문입니다.'), 'utf8');
    const second = await scanWikiMarkdownVault();
    assert.equal(second.issueCount, 0);
    const secondDetail: any = await wikiMarkdownDetail('wiki-eval-matter-001');
    assert.equal(secondDetail.revisions.length, 2);
    assert.equal(secondDetail.revisions[0].parentRevisionId, secondDetail.revisions[1].id);

    const renamedFile = path.join(matterDirectory, 'renamed-matter.md');
    renameSync(matterFile, renamedFile);
    await scanWikiMarkdownVault();
    const renamedDetail: any = await wikiMarkdownDetail('wiki-eval-matter-001');
    assert.equal(renamedDetail.document.relative_path, '10_Matters/renamed-matter.md');
    assert.equal(renamedDetail.revisions.length, 3);

    writeFileSync(renamedFile, matterMarkdown('# 사건 검토\n\n연결 변경 시도', 'another-matter'), 'utf8');
    const bindingScan = await scanWikiMarkdownVault();
    assert.ok((wikiMarkdownScanIssues(bindingScan.scanId) as any[]).some((issue) => issue.code === 'ENTITY_BINDING_CHANGED'));
    assert.equal((wikiMarkdownIndex() as any).documents.find((item: any) => item.docId === 'wiki-eval-matter-001').parseStatus, 'binding_conflict');

    writeFileSync(renamedFile, matterMarkdown('# 사건 검토\n\n사람이 수정한 두 번째 본문입니다.'), 'utf8');
    await scanWikiMarkdownVault();
    const duplicateFile = path.join(matterDirectory, 'duplicate.md');
    writeFileSync(duplicateFile, matterMarkdown('# 중복'), 'utf8');
    const duplicateScan = await scanWikiMarkdownVault();
    assert.ok((wikiMarkdownScanIssues(duplicateScan.scanId) as any[]).some((issue) => issue.code === 'DUPLICATE_DOC_ID'));
    assert.equal((wikiMarkdownIndex() as any).documents.find((item: any) => item.docId === 'wiki-eval-matter-001').parseStatus, 'duplicate');
    rmSync(duplicateFile);
    await scanWikiMarkdownVault();

    writeFileSync(path.join(noteDirectory, 'invalid.md'), `---\nschema_version: wiki-md-v1\ndoc_id: wiki-invalid-001\ndocument_type: note\ntitle: 잘못된 승인\napproved: true\n---\n`, 'utf8');
    const invalidScan = await scanWikiMarkdownVault();
    assert.ok((wikiMarkdownScanIssues(invalidScan.scanId) as any[]).some((issue) => issue.code === 'FRONTMATTER_INVALID'));

    writeFileSync(renamedFile, matterMarkdown('# 사건 검토\n\n아직 다시 색인하지 않은 편집입니다.'), 'utf8');
    const staleDetail: any = await wikiMarkdownDetail('wiki-eval-matter-001');
    assert.equal(staleDetail.indexStale, true);

    const outside = path.join(temporaryRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    try {
      symlinkSync(outside, path.join(noteDirectory, 'outside-link'), 'junction');
      const symlinkScan = await scanWikiMarkdownVault();
      assert.ok((wikiMarkdownScanIssues(symlinkScan.scanId) as any[]).some((issue) => issue.code === 'SYMLINK_BLOCKED'));
    } catch (error: any) {
      if (!['EPERM', 'EACCES'].includes(error?.code)) throw error;
    }

    rmSync(renamedFile);
    await scanWikiMarkdownVault();
    const missingDetail: any = await wikiMarkdownDetail('wiki-eval-matter-001');
    assert.equal(missingDetail.missing, true);
    assert.equal(missingDetail.document.parse_status, 'missing');

    console.log('wiki Markdown reader, index, history, conflict and rescan tests passed');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
