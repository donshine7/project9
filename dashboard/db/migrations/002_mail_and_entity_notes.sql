ALTER TABLE matter ADD COLUMN note TEXT;
ALTER TABLE organization ADD COLUMN note TEXT;
ALTER TABLE person ADD COLUMN note TEXT;

CREATE UNIQUE INDEX idx_organization_active_name ON organization(name) WHERE archived_at IS NULL;
CREATE INDEX idx_person_active_email ON person(email) WHERE archived_at IS NULL;

CREATE TABLE mail_item (
  id TEXT PRIMARY KEY,
  outlook_entry_id TEXT NOT NULL UNIQUE,
  internet_message_id TEXT,
  conversation_id TEXT,
  folder_path TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('received', 'sent')),
  subject TEXT NOT NULL,
  sender_name TEXT,
  sender_email TEXT,
  recipients_json TEXT NOT NULL DEFAULT '{}',
  mail_at TEXT NOT NULL,
  body_text TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

CREATE TABLE mail_matter_link (
  mail_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  match_source TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (mail_id, matter_id),
  FOREIGN KEY (mail_id) REFERENCES mail_item(id),
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE TABLE mail_daily_summary (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  summary_date TEXT NOT NULL,
  content TEXT NOT NULL,
  source_mail_ids_json TEXT NOT NULL DEFAULT '[]',
  summary_type TEXT NOT NULL CHECK (summary_type IN ('deterministic', 'llm')),
  model TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (matter_id, summary_date),
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE INDEX idx_mail_at ON mail_item(mail_at DESC);
CREATE INDEX idx_mail_conversation ON mail_item(conversation_id, mail_at);
CREATE INDEX idx_mail_link_matter ON mail_matter_link(matter_id, created_at DESC);
CREATE INDEX idx_mail_summary_matter ON mail_daily_summary(matter_id, summary_date DESC);
