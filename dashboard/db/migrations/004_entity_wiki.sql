CREATE TABLE wiki_entry (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('matter','organization','person','group')),
  entity_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  date_basis TEXT NOT NULL CHECK(date_basis IN ('mail_date','user_date')),
  content TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('user_input','verified_mail')),
  event_id TEXT NOT NULL UNIQUE REFERENCES event(id),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source_candidate_id TEXT REFERENCES analysis_candidate(id),
  supersedes_id TEXT UNIQUE REFERENCES wiki_entry(id),
  created_at TEXT NOT NULL,
  UNIQUE(entity_type,entity_id,source_candidate_id)
);
CREATE INDEX idx_wiki_entry_entity ON wiki_entry(entity_type,entity_id,entry_date DESC);
CREATE TABLE entity_wiki_revision (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('matter','organization','person','group')),
  entity_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES decision_run(id),
  sections_json TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  publication_event_id TEXT NOT NULL REFERENCES event(id),
  created_at TEXT NOT NULL,
  UNIQUE(entity_type,entity_id,version)
);
CREATE TABLE wiki_draft (
  run_id TEXT PRIMARY KEY REFERENCES decision_run(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  sections_json TEXT NOT NULL,
  change_summary TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','published','rejected')),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_wiki_draft_entity ON wiki_draft(entity_type,entity_id,created_at DESC);
ALTER TABLE decision_run ADD COLUMN retry_of TEXT REFERENCES decision_run(id);
PRAGMA optimize;
