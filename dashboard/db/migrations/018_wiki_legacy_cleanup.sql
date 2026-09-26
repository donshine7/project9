CREATE TABLE wiki_legacy_cleanup_run (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL CHECK(profile IN ('development','eval','test')),
  output_root TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('ready','blocked')),
  revision_count INTEGER NOT NULL,
  eligible_revision_count INTEGER NOT NULL,
  blocked_revision_count INTEGER NOT NULL,
  draft_count INTEGER NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE wiki_legacy_cleanup_item (
  id TEXT PRIMARY KEY,
  cleanup_run_id TEXT NOT NULL REFERENCES wiki_legacy_cleanup_run(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('revision','draft')),
  source_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('matter','organization','person','group')),
  entity_id TEXT NOT NULL,
  eligibility TEXT NOT NULL CHECK(eligibility IN ('eligible','blocked')),
  body_hash TEXT NOT NULL,
  archive_relative_path TEXT NOT NULL,
  archive_hash TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(cleanup_run_id, source_kind, source_id),
  UNIQUE(cleanup_run_id, archive_relative_path)
);

CREATE INDEX idx_wiki_legacy_cleanup_item_run ON wiki_legacy_cleanup_item(cleanup_run_id, eligibility, source_kind);

PRAGMA optimize;
