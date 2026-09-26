import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessWikiScaleReadiness, inspectOperationalWikiReadiness } from '../lib/wiki-scale';
import { scanWikiMarkdownVault } from '../lib/wiki-markdown';
import { withDatabase } from '../lib/work-db';

const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-wiki-stage7-'));
const vault = path.join(root, 'vault');
const notes = path.join(vault, '60_Notes');
const database = path.join(root, 'db', 'work.db');

process.env.SSPAT_RUNTIME_PROFILE = 'test';
process.env.SSPAT_ISOLATED_ROOT = root;
process.env.SSPAT_WORK_DB_PATH = database;
process.env.SSPAT_WIKI_VAULT_PATH = vault;
process.env.SSPAT_NOTICE_PROJECT_ROOT = path.join(root, 'notice');
process.env.SSPAT_SPEC_PROJECT_ROOT = path.join(root, 'spec');
process.env.SSPAT_PROVISIONAL_PROJECT_ROOT = path.join(root, 'provisional');

function markdown(index: number, version: number) {
  return `---\nschema_version: wiki-md-v1\ndoc_id: wiki-scale-${String(index).padStart(3, '0')}\ndocument_type: note\nentity_type: null\nentity_id: null\ntitle: Scale ${index}\ntags: [scale]\n---\n# Scale ${index}\n\nversion ${version}\n`;
}

function hash(file: string) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
  try {
    mkdirSync(notes, { recursive: true });
    for (let index = 1; index <= 40; index += 1) writeFileSync(path.join(notes, `scale-${String(index).padStart(3, '0')}.md`), markdown(index, 1), 'utf8');

    const first = await scanWikiMarkdownVault({ forceFull: true });
    assert.equal(first.changedCount, 40);
    assert.equal(first.unchangedCount, 0);

    const second = await scanWikiMarkdownVault();
    assert.equal(second.changedCount, 0);
    assert.equal(second.unchangedCount, 40);
    assert.equal(second.processingMode, 'content_incremental');

    for (let index = 1; index <= 5; index += 1) writeFileSync(path.join(notes, `scale-${String(index).padStart(3, '0')}.md`), markdown(index, 2), 'utf8');
    const third = await scanWikiMarkdownVault();
    assert.equal(third.changedCount, 5);
    assert.equal(third.unchangedCount, 35);
    assert.equal(withDatabase((db) => Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_markdown_revision').get() as any).count)), 45);

    const assessment = await assessWikiScaleReadiness({ thresholds: { minDocuments: 40, maxElapsedMs: 30_000 } });
    assert.equal(assessment.status, 'passed');
    assert.equal(assessment.scan.changedCount, 0);
    assert.equal(assessment.scan.unchangedCount, 40);
    assert.equal(withDatabase((db) => Number((db.prepare('SELECT COUNT(*) AS count FROM wiki_scale_run').get() as any).count)), 1);

    const before = hash(database);
    const readiness = inspectOperationalWikiReadiness({ databasePath: database, vaultPath: vault });
    assert.equal(readiness.readOnly, true);
    assert.equal(readiness.summary.documentCount, 40);
    assert.equal(hash(database), before, '운영 준비도 조사는 DB를 변경하면 안 된다.');

    console.log('Stage 7 incremental content scan, scale metrics and read-only operational readiness tests passed.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
