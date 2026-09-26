ALTER TABLE wiki_markdown_scan ADD COLUMN processing_mode TEXT NOT NULL DEFAULT 'full_parse'
  CHECK(processing_mode IN ('full_parse','content_incremental'));
ALTER TABLE wiki_markdown_scan ADD COLUMN changed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wiki_markdown_scan ADD COLUMN unchanged_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wiki_markdown_scan ADD COLUMN elapsed_ms INTEGER;

CREATE TABLE wiki_scale_run (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL CHECK(profile IN ('development','eval','test')),
  scan_id TEXT NOT NULL UNIQUE REFERENCES wiki_markdown_scan(id),
  status TEXT NOT NULL CHECK(status IN ('passed','failed')),
  document_count INTEGER NOT NULL,
  valid_document_count INTEGER NOT NULL,
  changed_document_count INTEGER NOT NULL,
  unchanged_document_count INTEGER NOT NULL,
  issue_count INTEGER NOT NULL,
  markdown_source_count INTEGER NOT NULL,
  legacy_source_count INTEGER NOT NULL,
  review_ready_count INTEGER NOT NULL,
  stale_proposal_count INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  thresholds_json TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_wiki_scale_run_created ON wiki_scale_run(created_at DESC);

PRAGMA optimize;
