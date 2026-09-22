CREATE TABLE notice (
  id TEXT PRIMARY KEY,
  notice_key TEXT NOT NULL UNIQUE CHECK (length(notice_key) BETWEEN 16 AND 128),
  matter_id TEXT NOT NULL,
  matter_reference TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(matter_reference)) BETWEEN 4 AND 64),
  notice_kind TEXT NOT NULL CHECK (notice_kind IN ('opinion_submission', 'rejection_decision')),
  external_notice_id TEXT,
  identity_basis TEXT NOT NULL CHECK (identity_basis IN ('external_notice_id', 'progress_sequence_and_notice_date', 'notice_date_provisional')),
  progress_sequence TEXT,
  notice_date TEXT NOT NULL CHECK (notice_date GLOB '????-??-??'),
  due_date TEXT CHECK (due_date IS NULL OR due_date GLOB '????-??-??'),
  oa_sequence INTEGER CHECK (oa_sequence IS NULL OR oa_sequence >= 1),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (
    status IN ('candidate', 'ready', 'held', 'downloading', 'packaged', 'published', 'failed', 'superseded')
  ),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE UNIQUE INDEX idx_notice_external_identity
  ON notice(matter_id, notice_kind, external_notice_id)
  WHERE external_notice_id IS NOT NULL;
CREATE INDEX idx_notice_matter_date ON notice(matter_id, notice_date DESC, notice_kind);
CREATE INDEX idx_notice_status ON notice(status, updated_at DESC);

CREATE TABLE notice_mail_link (
  notice_id TEXT NOT NULL,
  mail_id TEXT NOT NULL,
  mail_role TEXT NOT NULL CHECK (mail_role IN ('work_request', 'assignment', 'correction', 'other_evidence')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (notice_id, mail_id),
  FOREIGN KEY (notice_id) REFERENCES notice(id),
  FOREIGN KEY (mail_id) REFERENCES mail_item(id)
);
CREATE INDEX idx_notice_mail_mail ON notice_mail_link(mail_id, notice_id);

CREATE TABLE notice_attachment (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  attachment_version INTEGER NOT NULL CHECK (attachment_version >= 1),
  source_position INTEGER NOT NULL CHECK (source_position >= 1),
  document_name TEXT,
  registered_at TEXT,
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 260),
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
  sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL DEFAULT 'listed' CHECK (state IN ('listed', 'downloaded', 'verified', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (notice_id, attachment_version, source_position),
  FOREIGN KEY (notice_id) REFERENCES notice(id)
);
CREATE INDEX idx_notice_attachment_version ON notice_attachment(notice_id, attachment_version, source_position);

CREATE TABLE download_job (
  id TEXT PRIMARY KEY,
  notice_id TEXT NOT NULL,
  attachment_version INTEGER NOT NULL CHECK (attachment_version >= 1),
  package_version INTEGER NOT NULL CHECK (package_version >= 1),
  expected_file_name TEXT NOT NULL CHECK (length(trim(expected_file_name)) BETWEEN 1 AND 260),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'staged', 'verified', 'published', 'held', 'failed', 'cancelled')),
  lock_token TEXT,
  error_code TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (notice_id, package_version),
  FOREIGN KEY (notice_id) REFERENCES notice(id)
);
CREATE UNIQUE INDEX idx_download_job_active_notice
  ON download_job(notice_id)
  WHERE status IN ('queued', 'running', 'staged', 'verified');
CREATE INDEX idx_download_job_status ON download_job(status, requested_at);

CREATE TABLE download_package (
  id TEXT PRIMARY KEY,
  download_job_id TEXT NOT NULL UNIQUE,
  notice_id TEXT NOT NULL,
  package_version INTEGER NOT NULL CHECK (package_version >= 1),
  file_name TEXT NOT NULL CHECK (length(trim(file_name)) BETWEEN 1 AND 260),
  destination_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  file_size_bytes INTEGER NOT NULL CHECK (file_size_bytes >= 0),
  item_count INTEGER NOT NULL CHECK (item_count >= 1),
  manifest_json TEXT NOT NULL DEFAULT '{}',
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (notice_id, package_version),
  FOREIGN KEY (download_job_id) REFERENCES download_job(id),
  FOREIGN KEY (notice_id) REFERENCES notice(id)
);
CREATE INDEX idx_download_package_notice ON download_package(notice_id, published_at DESC);
