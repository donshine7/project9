-- A completed archive run declares its exact item count. Once that count is
-- present, later writers cannot append records to the sealed ledger.
CREATE TRIGGER wiki_legacy_archive_item_no_append_after_expected
BEFORE INSERT ON wiki_legacy_archive_item
WHEN (SELECT COUNT(*) FROM wiki_legacy_archive_item WHERE archive_run_id=NEW.archive_run_id)
  >= (SELECT revision_count + historic_revision_count + draft_count
      FROM wiki_legacy_archive_run WHERE id=NEW.archive_run_id)
BEGIN SELECT RAISE(ABORT,'sealed wiki archive run cannot accept more items'); END;

PRAGMA optimize;
