-- BUILD-F records a sealed copy and its evidence. It deliberately has no
-- redaction or deletion column, trigger, or operation.
CREATE TABLE wiki_legacy_archive_run (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL CHECK(profile IN ('development','eval','test')),
  output_root TEXT NOT NULL UNIQUE,
  source_snapshot_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('evidence_complete','blocked')),
  revision_count INTEGER NOT NULL,
  historic_revision_count INTEGER NOT NULL,
  draft_count INTEGER NOT NULL,
  blocked_count INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE wiki_legacy_archive_item (
  id TEXT PRIMARY KEY,
  archive_run_id TEXT NOT NULL REFERENCES wiki_legacy_archive_run(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('revision','historic_revision','draft')),
  source_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_body_hash TEXT NOT NULL,
  archive_relative_path TEXT NOT NULL,
  archive_hash TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  blockers_json TEXT NOT NULL,
  UNIQUE(archive_run_id,source_kind,source_id),
  UNIQUE(archive_run_id,archive_relative_path)
);

CREATE TRIGGER wiki_legacy_archive_run_no_update BEFORE UPDATE ON wiki_legacy_archive_run
BEGIN SELECT RAISE(ABORT,'sealed wiki archive run cannot be changed'); END;
CREATE TRIGGER wiki_legacy_archive_run_no_delete BEFORE DELETE ON wiki_legacy_archive_run
BEGIN SELECT RAISE(ABORT,'sealed wiki archive run cannot be deleted'); END;
CREATE TRIGGER wiki_legacy_archive_item_no_update BEFORE UPDATE ON wiki_legacy_archive_item
BEGIN SELECT RAISE(ABORT,'sealed wiki archive item cannot be changed'); END;
CREATE TRIGGER wiki_legacy_archive_item_no_delete BEFORE DELETE ON wiki_legacy_archive_item
BEGIN SELECT RAISE(ABORT,'sealed wiki archive item cannot be deleted'); END;

PRAGMA optimize;
