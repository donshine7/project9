CREATE TABLE wiki_auto_apply_approval (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES wiki_proposal(id),
  reviewer TEXT NOT NULL,
  reviewed_base_byte_hash TEXT NOT NULL,
  reviewed_target_byte_hash TEXT NOT NULL,
  reviewed_evidence_snapshot_hash TEXT NOT NULL,
  approval_event_id TEXT NOT NULL UNIQUE REFERENCES event(id),
  created_at TEXT NOT NULL
);

CREATE TABLE wiki_apply_operation (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES wiki_proposal(id),
  approval_id TEXT NOT NULL UNIQUE REFERENCES wiki_auto_apply_approval(id),
  doc_id TEXT NOT NULL REFERENCES wiki_document(doc_id),
  status TEXT NOT NULL CHECK(status IN ('prepared','file_applied','indexed','succeeded','conflict','failed')),
  base_byte_hash TEXT NOT NULL,
  target_byte_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  applied_revision_id TEXT REFERENCES wiki_markdown_revision(id),
  apply_event_id TEXT UNIQUE REFERENCES event(id),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_wiki_apply_operation_status ON wiki_apply_operation(status, updated_at);

PRAGMA optimize;
