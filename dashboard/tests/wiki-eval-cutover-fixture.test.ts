import assert from 'node:assert/strict';
import { assertSyntheticMarkdownInitialization } from '../scripts/wiki-eval-cutover-runner';

const docId = 'wiki-stage6-contract-001';
const document = { entity_type: 'matter', entity_id: 'stage6-matter-001' };
const sourceMode = {
  doc_id: docId,
  source_mode: 'markdown',
  legacy_entity_type: null,
  legacy_entity_id: null,
  migration_item_id: null,
  changed_by_event_id: 'stage6-init-event-001',
};
const initializationEvent = {
  id: 'stage6-init-event-001',
  entity_type: 'matter',
  entity_id: 'stage6-matter-001',
  event_type: 'wiki.source_mode_initialized',
  actor: 'Wiki Markdown indexer',
  source_type: 'system',
  after_json: JSON.stringify({
    schema: 'wiki-source-mode-initialization-v1',
    docId,
    sourceMode: 'markdown',
    reason: 'new_document_without_legacy_source',
  }),
};

assert.doesNotThrow(() => assertSyntheticMarkdownInitialization(docId, document, sourceMode, initializationEvent));
for (const [label, mode, event] of [
  ['missing mode', undefined, initializationEvent],
  ['wrong mode', { ...sourceMode, source_mode: 'legacy_db' }, initializationEvent],
  ['misbound entity', sourceMode, { ...initializationEvent, entity_id: 'other-matter' }],
  ['missing event', sourceMode, undefined],
  ['wrong event payload', sourceMode, { ...initializationEvent, after_json: JSON.stringify({ ...JSON.parse(initializationEvent.after_json), docId: 'other-doc' }) }],
] as const) {
  assert.throws(
    () => assertSyntheticMarkdownInitialization(docId, document, mode as any, event as any),
    /STAGE6_SOURCE_MODE_CONTRACT/,
    label,
  );
}

console.log('Stage 6 eval source-mode fixture contract tests passed.');
