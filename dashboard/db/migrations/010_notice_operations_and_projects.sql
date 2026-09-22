-- @foreign-keys-off

CREATE TABLE notice_v2 (
  id TEXT PRIMARY KEY,
  notice_key TEXT NOT NULL UNIQUE CHECK (length(notice_key) BETWEEN 16 AND 128),
  matter_id TEXT NOT NULL,
  matter_reference TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(matter_reference)) BETWEEN 4 AND 64),
  notice_kind TEXT NOT NULL CHECK (notice_kind IN ('opinion_submission', 'rejection_decision', 'priority_exam_supplement_request')),
  external_notice_id TEXT,
  identity_basis TEXT NOT NULL CHECK (identity_basis IN ('external_notice_id', 'progress_sequence_and_notice_date', 'notice_date_provisional')),
  progress_sequence TEXT,
  notice_date TEXT NOT NULL CHECK (notice_date GLOB '????-??-??'),
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '????-??-??'),
  oa_sequence INTEGER CHECK (oa_sequence IS NULL OR oa_sequence >= 1),
  rejection_sequence INTEGER CHECK (rejection_sequence IS NULL OR rejection_sequence >= 1),
  supplement_sequence INTEGER CHECK (supplement_sequence IS NULL OR supplement_sequence >= 1),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (
    status IN ('candidate', 'ready', 'held', 'downloading', 'packaged', 'published', 'failed', 'superseded')
  ),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (matter_id) REFERENCES matter(id),
  CHECK (
    (notice_kind = 'opinion_submission' AND rejection_sequence IS NULL AND supplement_sequence IS NULL)
    OR (notice_kind = 'rejection_decision' AND oa_sequence IS NULL AND supplement_sequence IS NULL)
    OR (notice_kind = 'priority_exam_supplement_request' AND oa_sequence IS NULL AND rejection_sequence IS NULL)
  )
);

INSERT INTO notice_v2(
  id, notice_key, matter_id, matter_reference, notice_kind, external_notice_id,
  identity_basis, progress_sequence, notice_date, due_date, oa_sequence,
  rejection_sequence, supplement_sequence, status, evidence_json, row_version,
  created_at, updated_at
)
SELECT
  id, notice_key, matter_id, matter_reference, notice_kind, external_notice_id,
  identity_basis, progress_sequence, notice_date, due_date,
  CASE WHEN notice_kind = 'opinion_submission' THEN oa_sequence ELSE NULL END,
  CASE WHEN notice_kind = 'rejection_decision' THEN oa_sequence ELSE NULL END,
  NULL, status, evidence_json, row_version, created_at, updated_at
FROM notice;

DROP TABLE notice;
ALTER TABLE notice_v2 RENAME TO notice;

CREATE UNIQUE INDEX idx_notice_external_identity
  ON notice(matter_id, notice_kind, external_notice_id)
  WHERE external_notice_id IS NOT NULL;
CREATE INDEX idx_notice_matter_date ON notice(matter_id, notice_date DESC, notice_kind);
CREATE INDEX idx_notice_status ON notice(status, updated_at DESC);

CREATE TABLE notice_detection_run (
  id TEXT PRIMARY KEY,
  scheduled_for TEXT NOT NULL,
  schedule_date TEXT NOT NULL CHECK (schedule_date GLOB '????-??-??'),
  started_at TEXT,
  completed_at TEXT,
  recovery_from TEXT,
  scan_to TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'partial', 'failed', 'outlook_unavailable', 'cancelled')),
  last_safe_stage TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  detected_mail_count INTEGER NOT NULL DEFAULT 0 CHECK (detected_mail_count >= 0),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  resumed_count INTEGER NOT NULL DEFAULT 0 CHECK (resumed_count >= 0),
  published_count INTEGER NOT NULL DEFAULT 0 CHECK (published_count >= 0),
  held_count INTEGER NOT NULL DEFAULT 0 CHECK (held_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(schedule_date, attempt_number)
);
CREATE INDEX idx_notice_detection_run_started ON notice_detection_run(started_at DESC, scheduled_for DESC);

CREATE TABLE notice_run_item (
  run_id TEXT NOT NULL,
  notice_id TEXT NOT NULL,
  download_job_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('candidate', 'resumed', 'held', 'failed', 'published', 'duplicate', 'not_target')),
  duplicate_mail_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_mail_count >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, notice_id),
  FOREIGN KEY (run_id) REFERENCES notice_detection_run(id),
  FOREIGN KEY (notice_id) REFERENCES notice(id),
  FOREIGN KEY (download_job_id) REFERENCES download_job(id)
);
CREATE INDEX idx_notice_run_item_notice ON notice_run_item(notice_id, updated_at DESC);

CREATE TABLE notice_pipeline_event (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  download_job_id TEXT,
  run_id TEXT,
  stage_key TEXT NOT NULL CHECK (length(trim(stage_key)) BETWEEN 2 AND 80),
  status TEXT NOT NULL CHECK (status IN ('started', 'progress', 'completed', 'held', 'failed', 'reconciled')),
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number >= 1),
  processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
  total_count INTEGER CHECK (total_count IS NULL OR total_count >= 0),
  error_code TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (notice_id) REFERENCES notice(id),
  FOREIGN KEY (download_job_id) REFERENCES download_job(id),
  FOREIGN KEY (run_id) REFERENCES notice_detection_run(id)
);
CREATE INDEX idx_notice_pipeline_event_notice ON notice_pipeline_event(notice_id, occurred_at DESC);
CREATE INDEX idx_notice_pipeline_event_job ON notice_pipeline_event(download_job_id, occurred_at DESC);

CREATE TABLE notice_operator_request (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  download_job_id TEXT,
  request_kind TEXT NOT NULL CHECK (request_kind IN ('recheck', 'resume')),
  expected_row_version INTEGER NOT NULL CHECK (expected_row_version >= 1),
  input_hash TEXT CHECK (input_hash IS NULL OR (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'rejected', 'cancelled')),
  processed_run_id TEXT,
  result_code TEXT,
  requested_at TEXT NOT NULL,
  processed_at TEXT,
  FOREIGN KEY (notice_id) REFERENCES notice(id),
  FOREIGN KEY (download_job_id) REFERENCES download_job(id),
  FOREIGN KEY (processed_run_id) REFERENCES notice_detection_run(id)
);
CREATE UNIQUE INDEX idx_notice_operator_request_pending
  ON notice_operator_request(notice_id, request_kind)
  WHERE status IN ('pending', 'accepted');

CREATE TABLE notice_project_link (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL UNIQUE,
  project_name TEXT NOT NULL CHECK (length(trim(project_name)) BETWEEN 2 AND 120),
  project_relative_path TEXT NOT NULL UNIQUE CHECK (length(trim(project_relative_path)) BETWEEN 2 AND 180),
  client_label TEXT NOT NULL CHECK (length(trim(client_label)) BETWEEN 1 AND 80),
  creation_status TEXT NOT NULL CHECK (creation_status IN ('previewed', 'creating', 'created', 'failed', 'linked_existing')),
  creation_manifest_sha256 TEXT CHECK (creation_manifest_sha256 IS NULL OR (length(creation_manifest_sha256) = 64 AND creation_manifest_sha256 NOT GLOB '*[^0-9a-f]*')),
  preview_token_hash TEXT CHECK (preview_token_hash IS NULL OR (length(preview_token_hash) = 64 AND preview_token_hash NOT GLOB '*[^0-9a-f]*')),
  source_package_sha256 TEXT NOT NULL CHECK (length(source_package_sha256) = 64 AND source_package_sha256 NOT GLOB '*[^0-9a-f]*'),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (notice_id) REFERENCES notice(id)
);

CREATE TABLE notice_project_stage (
  project_id TEXT PRIMARY KEY,
  stage_key TEXT NOT NULL CHECK (stage_key IN ('project_created', 'intake', 'analysis', 'strategy', 'drafting', 'review', 'awaiting_submission_approval', 'approved', 'submitted', 'completed')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'held', 'completed')),
  user_action_code TEXT CHECK (user_action_code IS NULL OR user_action_code IN (
    'confirm_project_identity', 'connect_codex_project', 'create_intake_task',
    'provide_missing_sources', 'confirm_deadline_or_procedure', 'select_strategy',
    'approve_draft_scope', 'approve_submission_copy', 'external_dispatch_required',
    'record_filing_receipt'
  )),
  action_summary TEXT,
  artifact_path TEXT,
  artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR (length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*')),
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES notice_project_link(id)
);

CREATE TABLE notice_project_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) BETWEEN 2 AND 80),
  before_json TEXT,
  after_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES notice_project_link(id)
);
CREATE INDEX idx_notice_project_event_project ON notice_project_event(project_id, created_at DESC);
