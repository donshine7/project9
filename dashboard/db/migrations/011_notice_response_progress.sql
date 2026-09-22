ALTER TABLE notice_project_stage ADD COLUMN stage_number INTEGER NOT NULL DEFAULT 3 CHECK (stage_number BETWEEN 1 AND 13);
ALTER TABLE notice_project_stage ADD COLUMN blocked_reason TEXT;
ALTER TABLE notice_project_stage ADD COLUMN last_reconciled_at TEXT;

UPDATE notice_project_stage
SET stage_number = CASE stage_key
  WHEN 'project_created' THEN 3
  WHEN 'intake' THEN 4
  WHEN 'analysis' THEN 5
  WHEN 'strategy' THEN 7
  WHEN 'drafting' THEN 8
  WHEN 'review' THEN 10
  WHEN 'awaiting_submission_approval' THEN 11
  WHEN 'approved' THEN 12
  WHEN 'submitted' THEN 13
  WHEN 'completed' THEN 13
  ELSE 3
END;

CREATE TABLE notice_project_artifact (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  stage_number INTEGER NOT NULL CHECK (stage_number BETWEEN 1 AND 13),
  artifact_kind TEXT NOT NULL CHECK (length(trim(artifact_kind)) BETWEEN 2 AND 80),
  relative_path TEXT NOT NULL CHECK (length(trim(relative_path)) BETWEEN 1 AND 500),
  artifact_version TEXT,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK (state IN ('observed', 'verified', 'approved', 'superseded', 'mismatch')),
  source_type TEXT NOT NULL CHECK (source_type IN ('automation', 'user', 'filesystem')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, artifact_kind, relative_path, sha256),
  FOREIGN KEY (project_id) REFERENCES notice_project_link(id)
);
CREATE INDEX idx_notice_project_artifact_project ON notice_project_artifact(project_id, stage_number, updated_at DESC);

CREATE TABLE notice_project_approval (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  approval_kind TEXT NOT NULL CHECK (approval_kind IN ('strategy_selection', 'draft_scope', 'submission_copy', 'external_dispatch', 'filing_receipt')),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
  target_artifact_id TEXT,
  target_relative_path TEXT,
  target_version TEXT,
  target_sha256 TEXT CHECK (target_sha256 IS NULL OR (length(target_sha256) = 64 AND target_sha256 NOT GLOB '*[^0-9a-f]*')),
  scope_json TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES notice_project_link(id),
  FOREIGN KEY (target_artifact_id) REFERENCES notice_project_artifact(id)
);
CREATE INDEX idx_notice_project_approval_project ON notice_project_approval(project_id, approval_kind, created_at DESC);

CREATE TABLE notice_project_task_link (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_kind TEXT NOT NULL CHECK (task_kind IN ('intake', 'analysis', 'strategy', 'draft', 'review')),
  task_title TEXT NOT NULL CHECK (length(trim(task_title)) BETWEEN 2 AND 200),
  external_task_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('linked', 'completed', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, task_kind),
  FOREIGN KEY (project_id) REFERENCES notice_project_link(id)
);
CREATE INDEX idx_notice_project_task_project ON notice_project_task_link(project_id, updated_at DESC);
