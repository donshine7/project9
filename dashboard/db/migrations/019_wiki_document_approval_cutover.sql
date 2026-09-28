-- @foreign-keys-off

CREATE TABLE wiki_cutover_run_new (
  id TEXT PRIMARY KEY,
  authorization_id TEXT NOT NULL UNIQUE,
  reviewer TEXT NOT NULL,
  runtime_profile TEXT NOT NULL CHECK(runtime_profile IN ('operational','development','eval','test')),
  code_commit TEXT,
  bundle_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('prepared','applied','succeeded','failed')),
  target_count INTEGER NOT NULL CHECK(target_count BETWEEN 1 AND 5),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

INSERT INTO wiki_cutover_run_new
SELECT * FROM wiki_cutover_run;

CREATE TABLE wiki_cutover_item_new (
  id TEXT PRIMARY KEY,
  cutover_run_id TEXT NOT NULL REFERENCES wiki_cutover_run_new(id),
  doc_id TEXT NOT NULL REFERENCES wiki_document(doc_id),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('matter','organization','person','group')),
  entity_id TEXT NOT NULL,
  previous_source_mode TEXT NOT NULL CHECK(previous_source_mode='legacy_db'),
  new_source_mode TEXT NOT NULL CHECK(new_source_mode='markdown'),
  expected_byte_hash TEXT NOT NULL,
  markdown_revision_id TEXT NOT NULL REFERENCES wiki_markdown_revision(id),
  proposal_id TEXT REFERENCES wiki_proposal(id),
  proposal_review_id TEXT REFERENCES wiki_proposal_review(id),
  document_approval_event_id TEXT REFERENCES event(id),
  legacy_revision_id TEXT NOT NULL REFERENCES entity_wiki_revision(id),
  source_change_event_id TEXT NOT NULL UNIQUE REFERENCES event(id),
  created_at TEXT NOT NULL,
  UNIQUE(cutover_run_id, doc_id),
  CHECK(
    (proposal_id IS NOT NULL AND proposal_review_id IS NOT NULL AND document_approval_event_id IS NULL)
    OR
    (proposal_id IS NULL AND proposal_review_id IS NULL AND document_approval_event_id IS NOT NULL)
  )
);

INSERT INTO wiki_cutover_item_new(
  id,cutover_run_id,doc_id,entity_type,entity_id,previous_source_mode,new_source_mode,
  expected_byte_hash,markdown_revision_id,proposal_id,proposal_review_id,
  document_approval_event_id,legacy_revision_id,source_change_event_id,created_at
)
SELECT
  id,cutover_run_id,doc_id,entity_type,entity_id,previous_source_mode,new_source_mode,
  expected_byte_hash,markdown_revision_id,proposal_id,proposal_review_id,
  NULL,legacy_revision_id,source_change_event_id,created_at
FROM wiki_cutover_item;

DROP TABLE wiki_cutover_item;
DROP TABLE wiki_cutover_run;
ALTER TABLE wiki_cutover_run_new RENAME TO wiki_cutover_run;
ALTER TABLE wiki_cutover_item_new RENAME TO wiki_cutover_item;

CREATE INDEX idx_wiki_cutover_item_document ON wiki_cutover_item(doc_id, created_at DESC);

PRAGMA optimize;
