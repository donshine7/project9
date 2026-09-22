CREATE TABLE specification_setup (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL CHECK (length(trim(case_id)) BETWEEN 2 AND 100),
  client_label TEXT NOT NULL CHECK (length(trim(client_label)) BETWEEN 1 AND 100),
  project_name TEXT NOT NULL UNIQUE CHECK (length(trim(project_name)) BETWEEN 2 AND 120),
  project_relative_path TEXT,
  service_type TEXT NOT NULL CHECK (service_type IN ('일반출원', '우선심사출원', '메이킹', '기획', '가출원')),
  invention_type TEXT NOT NULL CHECK (invention_type IN ('방법', '장치', '조성물', '혼합', '기타')),
  creation_direction TEXT,
  owner TEXT NOT NULL CHECK (length(trim(owner)) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'previewed', 'creating', 'created', 'ready', 'failed', 'cancelled')),
  preview_token TEXT,
  preview_fingerprint TEXT,
  sample_sha256 TEXT,
  last_error TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_specification_setup_status ON specification_setup(status, updated_at DESC);

CREATE TABLE specification_setup_step (
  setup_id TEXT NOT NULL,
  step_key TEXT NOT NULL CHECK (step_key IN ('case_info', 'copy_preview', 'folder_creation', 'codex_setup', 'source_materials', 'intake_start')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'user_action', 'verification_pending', 'confirmed', 'recheck_required')),
  actor TEXT NOT NULL CHECK (actor IN ('사용자', '시스템')),
  confirmed_at TEXT,
  evidence_type TEXT,
  evidence_ref TEXT,
  input_fingerprint TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (setup_id, step_key),
  FOREIGN KEY (setup_id) REFERENCES specification_setup(id)
);

CREATE TABLE specification_setup_event (
  id TEXT PRIMARY KEY,
  setup_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (setup_id) REFERENCES specification_setup(id)
);
CREATE INDEX idx_specification_setup_event ON specification_setup_event(setup_id, created_at DESC);

CREATE TABLE specification_project_check (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  project_relative_path TEXT NOT NULL,
  tool_version TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error')),
  input_fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_specification_project_check ON specification_project_check(project_id, created_at DESC);
