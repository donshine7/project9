CREATE TABLE wiki_cutover_run (
  id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL UNIQUE,
  reviewer TEXT NOT NULL,
  runtime_profile TEXT NOT NULL CHECK(runtime_profile IN ('development','eval','test')),
  code_commit TEXT,
  bundle_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('prepared','applied','succeeded','failed')),
  target_count INTEGER NOT NULL CHECK(target_count BETWEEN 1 AND 5),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE wiki_cutover_item (
  id TEXT PRIMARY KEY,
  cutover_run_id TEXT NOT NULL REFERENCES wiki_cutover_run(id),
  doc_id TEXT NOT NULL REFERENCES wiki_document(doc_id),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('matter','organization','person','group')),
  entity_id TEXT NOT NULL,
  previous_source_mode TEXT NOT NULL CHECK(previous_source_mode='legacy_db'),
  new_source_mode TEXT NOT NULL CHECK(new_source_mode='markdown'),
  expected_byte_hash TEXT NOT NULL,
  markdown_revision_id TEXT NOT NULL REFERENCES wiki_markdown_revision(id),
  proposal_id TEXT NOT NULL REFERENCES wiki_proposal(id),
  proposal_review_id TEXT NOT NULL REFERENCES wiki_proposal_review(id),
  legacy_revision_id TEXT NOT NULL REFERENCES entity_wiki_revision(id),
  source_change_event_id TEXT NOT NULL UNIQUE REFERENCES event(id),
  created_at TEXT NOT NULL,
  UNIQUE(cutover_run_id, doc_id)
);

CREATE INDEX idx_wiki_cutover_item_document ON wiki_cutover_item(doc_id, created_at DESC);

CREATE TABLE wiki_recovery_rehearsal (
  id TEXT PRIMARY KEY,
  cutover_run_id TEXT NOT NULL REFERENCES wiki_cutover_run(id),
  restore_root TEXT NOT NULL UNIQUE,
  restored_database_hash TEXT NOT NULL,
  restored_vault_hash TEXT NOT NULL,
  verification_hash TEXT NOT NULL,
  verified_document_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE INDEX idx_wiki_recovery_cutover ON wiki_recovery_rehearsal(cutover_run_id, created_at DESC);

PRAGMA optimize;
