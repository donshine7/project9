-- A sync_run records one Outlook collection attempt. A work_refresh_run records
-- the complete user-requested refresh across collection, analysis, review and
-- application. Keeping these concepts separate prevents source mail time,
-- request time and processing completion time from being conflated.
CREATE TABLE work_refresh_run (
  id TEXT PRIMARY KEY,
  request_channel TEXT NOT NULL CHECK (request_channel IN ('codex', 'dashboard', 'manual', 'scheduled')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  mail_window_from TEXT NOT NULL,
  mail_window_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (
    status IN ('requested', 'collecting', 'analyzing', 'review_pending', 'applying', 'completed', 'partial', 'failed', 'cancelled')
  ),
  reviewed_mail_from TEXT,
  reviewed_mail_to TEXT,
  target_mail_count INTEGER NOT NULL DEFAULT 0 CHECK (target_mail_count >= 0),
  reviewed_mail_count INTEGER NOT NULL DEFAULT 0 CHECK (reviewed_mail_count >= 0),
  pending_mail_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_mail_count >= 0),
  applied_item_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_item_count >= 0),
  held_item_count INTEGER NOT NULL DEFAULT 0 CHECK (held_item_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  collection_completed_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (mail_window_from <= mail_window_to),
  CHECK (reviewed_mail_from IS NULL OR reviewed_mail_to IS NULL OR reviewed_mail_from <= reviewed_mail_to),
  CHECK (reviewed_mail_count <= target_mail_count),
  CHECK (pending_mail_count <= target_mail_count)
);

CREATE TABLE work_refresh_mail (
  work_refresh_run_id TEXT NOT NULL,
  mail_id TEXT NOT NULL,
  source_sync_run_id TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    review_status IN ('pending', 'reviewed_no_change', 'candidate', 'applied', 'held', 'failed')
  ),
  reviewed_at TEXT,
  result_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (work_refresh_run_id, mail_id),
  FOREIGN KEY (work_refresh_run_id) REFERENCES work_refresh_run(id),
  FOREIGN KEY (mail_id) REFERENCES mail_item(id),
  FOREIGN KEY (source_sync_run_id) REFERENCES sync_run(id)
);

CREATE TABLE work_refresh_stage (
  id TEXT PRIMARY KEY,
  work_refresh_run_id TEXT NOT NULL,
  stage_key TEXT NOT NULL CHECK (length(trim(stage_key)) BETWEEN 1 AND 80),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'partial', 'failed', 'skipped')
  ),
  input_count INTEGER NOT NULL DEFAULT 0 CHECK (input_count >= 0),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  output_count INTEGER NOT NULL DEFAULT 0 CHECK (output_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  started_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_refresh_run_id, stage_key, attempt),
  FOREIGN KEY (work_refresh_run_id) REFERENCES work_refresh_run(id),
  CHECK (processed_count <= input_count)
);

-- A result is the audit link from a stage outcome to the exact source and, when
-- applicable, the model decision and immutable event that applied it.
CREATE TABLE work_refresh_result (
  id TEXT PRIMARY KEY,
  work_refresh_run_id TEXT NOT NULL,
  work_refresh_stage_id TEXT,
  subject_type TEXT NOT NULL CHECK (length(trim(subject_type)) BETWEEN 1 AND 80),
  subject_key TEXT NOT NULL CHECK (length(trim(subject_key)) BETWEEN 1 AND 500),
  outcome TEXT NOT NULL CHECK (outcome IN ('no_change', 'candidate', 'applied', 'held', 'failed')),
  source_type TEXT NOT NULL CHECK (length(trim(source_type)) BETWEEN 1 AND 80),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) BETWEEN 1 AND 500),
  source_at TEXT,
  decision_run_id TEXT,
  event_id TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (work_refresh_run_id) REFERENCES work_refresh_run(id),
  FOREIGN KEY (work_refresh_stage_id) REFERENCES work_refresh_stage(id),
  FOREIGN KEY (decision_run_id) REFERENCES decision_run(id),
  FOREIGN KEY (event_id) REFERENCES event(id),
  UNIQUE (work_refresh_run_id, subject_type, subject_key, outcome, source_type, source_id)
);

ALTER TABLE sync_run ADD COLUMN work_refresh_run_id TEXT REFERENCES work_refresh_run(id);
ALTER TABLE decision_run ADD COLUMN work_refresh_run_id TEXT REFERENCES work_refresh_run(id);

CREATE INDEX idx_work_refresh_run_status ON work_refresh_run(status, requested_at DESC);
CREATE INDEX idx_work_refresh_run_window ON work_refresh_run(mail_window_from, mail_window_to);
CREATE INDEX idx_work_refresh_mail_status ON work_refresh_mail(work_refresh_run_id, review_status);
CREATE INDEX idx_work_refresh_mail_sync ON work_refresh_mail(source_sync_run_id);
CREATE INDEX idx_work_refresh_stage_run ON work_refresh_stage(work_refresh_run_id, stage_key, attempt DESC);
CREATE INDEX idx_work_refresh_result_run ON work_refresh_result(work_refresh_run_id, outcome, created_at DESC);
CREATE INDEX idx_work_refresh_result_source ON work_refresh_result(source_type, source_id);
CREATE INDEX idx_sync_run_work_refresh ON sync_run(work_refresh_run_id, started_at DESC);
CREATE INDEX idx_decision_run_work_refresh ON decision_run(work_refresh_run_id, started_at DESC);

PRAGMA optimize;
