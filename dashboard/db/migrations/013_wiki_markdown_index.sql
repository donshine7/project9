CREATE TABLE wiki_markdown_scan (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  vault_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
  discovered_count INTEGER NOT NULL DEFAULT 0,
  indexed_count INTEGER NOT NULL DEFAULT 0,
  issue_count INTEGER NOT NULL DEFAULT 0,
  snapshot_hash TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE wiki_document (
  doc_id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL CHECK(document_type IN ('entity_wiki','knowledge','note')),
  entity_type TEXT CHECK(entity_type IN ('matter','organization','person','group','topic')),
  entity_id TEXT,
  title TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  byte_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  parse_status TEXT NOT NULL CHECK(parse_status IN ('valid','invalid','duplicate','binding_conflict','entity_missing','missing')),
  current_revision_id TEXT,
  last_seen_scan_id TEXT REFERENCES wiki_markdown_scan(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (document_type='entity_wiki' AND entity_type IN ('matter','organization','person','group') AND entity_id IS NOT NULL)
    OR (document_type IN ('knowledge','note') AND (entity_type IS NULL OR entity_type='topic'))
  )
);

CREATE TABLE wiki_markdown_revision (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES wiki_document(doc_id),
  revision_number INTEGER NOT NULL,
  parent_revision_id TEXT REFERENCES wiki_markdown_revision(id),
  scan_id TEXT NOT NULL REFERENCES wiki_markdown_scan(id),
  relative_path TEXT NOT NULL,
  byte_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  history_object_path TEXT NOT NULL,
  git_commit TEXT,
  git_blob TEXT,
  git_status TEXT NOT NULL CHECK(git_status IN ('committed','uncommitted','unavailable')),
  origin TEXT NOT NULL CHECK(origin IN ('human_observed','migration','eval','ai_applied')),
  observed_at TEXT NOT NULL,
  UNIQUE(doc_id, revision_number),
  UNIQUE(scan_id, doc_id)
);

CREATE TABLE wiki_markdown_scan_issue (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES wiki_markdown_scan(id),
  severity TEXT NOT NULL CHECK(severity IN ('warning','error')),
  code TEXT NOT NULL,
  relative_path TEXT,
  doc_id TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_wiki_document_entity ON wiki_document(entity_type, entity_id, parse_status);
CREATE INDEX idx_wiki_document_scan ON wiki_document(last_seen_scan_id, parse_status);
CREATE INDEX idx_wiki_revision_doc ON wiki_markdown_revision(doc_id, revision_number DESC);
CREATE INDEX idx_wiki_scan_started ON wiki_markdown_scan(started_at DESC);
CREATE INDEX idx_wiki_scan_issue_scan ON wiki_markdown_scan_issue(scan_id, severity, code);

PRAGMA optimize;
