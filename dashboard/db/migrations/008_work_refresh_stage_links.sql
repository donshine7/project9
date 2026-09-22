-- Link collection and model executions to an exact stage attempt. This also
-- changes result idempotency from run-wide to stage-scoped so the same mail can
-- legitimately produce outcomes in fact extraction, linking and Action review.
ALTER TABLE sync_run ADD COLUMN work_refresh_stage_id TEXT REFERENCES work_refresh_stage(id);
ALTER TABLE decision_run ADD COLUMN work_refresh_stage_id TEXT REFERENCES work_refresh_stage(id);

ALTER TABLE work_refresh_result RENAME TO work_refresh_result_v1;

CREATE TABLE work_refresh_result (
  id TEXT PRIMARY KEY,
  work_refresh_run_id TEXT NOT NULL,
  work_refresh_stage_id TEXT NOT NULL,
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
  UNIQUE (work_refresh_run_id, work_refresh_stage_id, subject_type, subject_key, outcome, source_type, source_id)
);

INSERT INTO work_refresh_result(
  id, work_refresh_run_id, work_refresh_stage_id, subject_type, subject_key,
  outcome, source_type, source_id, source_at, decision_run_id, event_id,
  result_json, created_at
)
SELECT
  id, work_refresh_run_id, work_refresh_stage_id, subject_type, subject_key,
  outcome, source_type, source_id, source_at, decision_run_id, event_id,
  result_json, created_at
FROM work_refresh_result_v1
WHERE work_refresh_stage_id IS NOT NULL;

DROP TABLE work_refresh_result_v1;

CREATE INDEX idx_work_refresh_result_run ON work_refresh_result(work_refresh_run_id, outcome, created_at DESC);
CREATE INDEX idx_work_refresh_result_source ON work_refresh_result(source_type, source_id);
CREATE INDEX idx_sync_run_work_refresh_stage ON sync_run(work_refresh_stage_id, started_at DESC);
CREATE INDEX idx_decision_run_work_refresh_stage ON decision_run(work_refresh_stage_id, started_at DESC);

PRAGMA optimize;
