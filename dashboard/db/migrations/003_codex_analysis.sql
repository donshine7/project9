ALTER TABLE input_snapshot ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE decision_run ADD COLUMN execution_ref TEXT;
ALTER TABLE decision_run ADD COLUMN result_json TEXT;

CREATE TABLE analysis_candidate (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES decision_run(id),
  candidate_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fact','link','action','risk','wiki')),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending',
  row_version INTEGER NOT NULL DEFAULT 1,
  applied_event_id TEXT REFERENCES event(id),
  created_at TEXT NOT NULL,
  UNIQUE(run_id, candidate_key)
);
CREATE INDEX idx_candidate_review ON analysis_candidate(review_status, created_at DESC);

-- Accepted atomic notes; manual entity.note remains separate and is never overwritten.
CREATE TABLE knowledge_entry (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('matter','organization','person','group','mail')),
  entity_id TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  content TEXT NOT NULL,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES analysis_candidate(id),
  event_id TEXT NOT NULL REFERENCES event(id),
  source_mail_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_knowledge_entity_date ON knowledge_entry(entity_type, entity_id, entry_date DESC);
