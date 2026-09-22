CREATE TABLE wiki_document_source_mode (
  doc_id TEXT PRIMARY KEY REFERENCES wiki_document(doc_id),
  source_mode TEXT NOT NULL CHECK(source_mode IN ('legacy_db','markdown')),
  legacy_entity_type TEXT CHECK(legacy_entity_type IN ('matter','organization','person','group')),
  legacy_entity_id TEXT,
  migration_item_id TEXT,
  changed_by_event_id TEXT REFERENCES event(id),
  changed_at TEXT NOT NULL,
  CHECK(
    source_mode='markdown'
    OR (legacy_entity_type IS NOT NULL AND legacy_entity_id IS NOT NULL)
  )
);

CREATE TABLE wiki_file_operation (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL CHECK(operation_type IN ('proposal_write','migration_dry_run')),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','file_written','verified','succeeded','conflict','failed')),
  base_byte_hash TEXT,
  target_byte_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(operation_type, subject_id)
);

CREATE TABLE wiki_proposal (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES decision_run(id),
  doc_id TEXT NOT NULL REFERENCES wiki_document(doc_id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES wiki_file_operation(id),
  base_revision_id TEXT REFERENCES wiki_markdown_revision(id),
  base_byte_hash TEXT NOT NULL,
  base_text_hash TEXT NOT NULL,
  evidence_snapshot_hash TEXT NOT NULL,
  proposal_relative_path TEXT NOT NULL UNIQUE,
  proposal_byte_hash TEXT NOT NULL,
  target_byte_hash TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','ready_for_review','reviewed','rejected','stale_document','stale_evidence','applied_observed','failed')),
  reviewer TEXT,
  reviewed_at TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE wiki_proposal_evidence (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES wiki_proposal(id),
  block_id TEXT NOT NULL,
  sentence_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('event','source')),
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK(validation_status IN ('valid','missing','changed','wrong_entity')),
  checked_at TEXT NOT NULL,
  UNIQUE(proposal_id, block_id, source_kind, source_id)
);

CREATE INDEX idx_wiki_proposal_document ON wiki_proposal(doc_id, created_at DESC);
CREATE INDEX idx_wiki_proposal_evidence ON wiki_proposal_evidence(proposal_id, validation_status);

CREATE TABLE wiki_proposal_review (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES wiki_proposal(id),
  action TEXT NOT NULL CHECK(action IN ('accept_for_manual_apply','reject')),
  reviewer TEXT NOT NULL,
  reviewed_base_byte_hash TEXT NOT NULL,
  reviewed_evidence_snapshot_hash TEXT NOT NULL,
  review_event_id TEXT NOT NULL UNIQUE REFERENCES event(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_wiki_proposal_review ON wiki_proposal_review(proposal_id, created_at DESC);

CREATE TABLE wiki_migration_run (
  id TEXT PRIMARY KEY,
  conversion_version TEXT NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  output_root TEXT NOT NULL,
  output_manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded','conflict','failed')),
  revision_count INTEGER NOT NULL,
  draft_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(conversion_version, source_snapshot_hash, output_root)
);

CREATE TABLE wiki_migration_item (
  id TEXT PRIMARY KEY,
  migration_run_id TEXT NOT NULL REFERENCES wiki_migration_run(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('published_revision','pending_draft','rejected_draft')),
  source_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('matter','organization','person','group')),
  entity_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  output_relative_path TEXT NOT NULL,
  output_byte_hash TEXT NOT NULL,
  sentence_count INTEGER NOT NULL,
  evidence_count INTEGER NOT NULL,
  source_created_at TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK(validation_status IN ('valid','invalid','conflict')),
  detail TEXT,
  UNIQUE(migration_run_id, source_kind, source_id),
  UNIQUE(migration_run_id, output_relative_path)
);

CREATE INDEX idx_wiki_migration_item_run ON wiki_migration_item(migration_run_id, source_kind, entity_type);

PRAGMA optimize;
