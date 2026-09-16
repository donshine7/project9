CREATE TABLE matter (
  id TEXT PRIMARY KEY,
  our_ref TEXT NOT NULL COLLATE NOCASE UNIQUE,
  office TEXT NOT NULL CHECK (office IN ('상상특허', '상상플러스')),
  matter_kind TEXT NOT NULL,
  country_code TEXT,
  base_ref TEXT NOT NULL,
  parent_ref TEXT,
  relation_type TEXT,
  suffixes_json TEXT NOT NULL DEFAULT '[]',
  source_type TEXT NOT NULL,
  source_id TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE matter_group (
  id TEXT PRIMARY KEY,
  group_ref TEXT NOT NULL COLLATE NOCASE UNIQUE,
  representative_matter_id TEXT,
  note TEXT,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (representative_matter_id) REFERENCES matter(id)
);

CREATE TABLE matter_group_member (
  group_id TEXT NOT NULL,
  matter_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, matter_id),
  FOREIGN KEY (group_id) REFERENCES matter_group(id),
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE TABLE organization (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE,
  contact_json TEXT NOT NULL DEFAULT '{}',
  source_type TEXT NOT NULL,
  source_id TEXT,
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE person (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT COLLATE NOCASE,
  organization_id TEXT,
  role_note TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (organization_id) REFERENCES organization(id)
);

CREATE TABLE matter_party (
  matter_id TEXT NOT NULL,
  party_type TEXT NOT NULL CHECK (party_type IN ('organization', 'person')),
  party_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (matter_id, party_type, party_id, role),
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE TABLE work_item (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  work_type TEXT NOT NULL,
  service_type TEXT,
  stage TEXT NOT NULL,
  current_status TEXT NOT NULL,
  cost_method TEXT,
  funding_source TEXT,
  base_date TEXT,
  commencement_date TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE TABLE assignment (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('assignee1', 'assignee2', 'db', 'retainer')),
  person_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (work_item_id) REFERENCES work_item(id)
);

CREATE TABLE matter_note (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  note_type TEXT NOT NULL CHECK (note_type IN ('user', 'llm')),
  content TEXT NOT NULL,
  author TEXT NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE TABLE action_item (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  work_item_id TEXT,
  title TEXT NOT NULL,
  assignee TEXT NOT NULL,
  manager TEXT NOT NULL DEFAULT '장진태',
  status TEXT NOT NULL CHECK (status IN ('대기', '진행중', '완료', '보류')),
  due_date TEXT,
  priority TEXT NOT NULL DEFAULT '보통' CHECK (priority IN ('낮음', '보통', '높음', '긴급')),
  evidence TEXT,
  source_type TEXT NOT NULL,
  source_id TEXT,
  confidence REAL NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1)),
  row_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (matter_id) REFERENCES matter(id),
  FOREIGN KEY (work_item_id) REFERENCES work_item(id)
);

CREATE TABLE event (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  actor TEXT NOT NULL,
  source_type TEXT NOT NULL,
  correlation_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE source_observation (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field_path TEXT NOT NULL,
  observed_value_json TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  observed_at TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0, 1))
);

CREATE TABLE input_snapshot (
  id TEXT PRIMARY KEY,
  matter_id TEXT,
  mail_ids_json TEXT NOT NULL DEFAULT '[]',
  entity_versions_json TEXT NOT NULL DEFAULT '{}',
  source_priority_version TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (matter_id) REFERENCES matter(id)
);

CREATE TABLE policy_revision (
  id TEXT PRIMARY KEY,
  revision_type TEXT NOT NULL,
  version TEXT NOT NULL,
  artifact_paths_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (revision_type, version)
);

CREATE TABLE decision_run (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT,
  operation TEXT NOT NULL,
  agent_name TEXT,
  model TEXT,
  reasoning_effort TEXT,
  prompt_version TEXT,
  policy_revision_id TEXT,
  routing_snapshot_json TEXT NOT NULL DEFAULT '{}',
  input_snapshot_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  output_hash TEXT,
  FOREIGN KEY (policy_revision_id) REFERENCES policy_revision(id),
  FOREIGN KEY (input_snapshot_id) REFERENCES input_snapshot(id)
);

CREATE TABLE decision_item (
  id TEXT PRIMARY KEY,
  decision_run_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  field_path TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  previous_value_json TEXT,
  proposed_value_json TEXT NOT NULL,
  normalized_value_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  risk_level TEXT NOT NULL,
  rationale TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_run_id) REFERENCES decision_run(id)
);

CREATE TABLE decision_evidence (
  id TEXT PRIMARY KEY,
  decision_item_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  locator_json TEXT NOT NULL DEFAULT '{}',
  excerpt TEXT,
  excerpt_hash TEXT NOT NULL,
  supports TEXT NOT NULL,
  FOREIGN KEY (decision_item_id) REFERENCES decision_item(id)
);

CREATE TABLE user_feedback (
  id TEXT PRIMARY KEY,
  decision_item_id TEXT,
  event_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  feedback_action TEXT NOT NULL,
  before_value_json TEXT,
  final_value_json TEXT NOT NULL,
  reason_code TEXT,
  note TEXT,
  new_evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (decision_item_id) REFERENCES decision_item(id),
  FOREIGN KEY (event_id) REFERENCES event(id)
);

CREATE TABLE decision_comparison (
  id TEXT PRIMARY KEY,
  user_feedback_id TEXT NOT NULL UNIQUE,
  comparison_type TEXT NOT NULL,
  changed_paths_json TEXT NOT NULL DEFAULT '[]',
  model_error_class TEXT NOT NULL,
  eligible_for_eval INTEGER NOT NULL DEFAULT 0 CHECK (eligible_for_eval IN (0, 1)),
  excluded_reason TEXT,
  compared_at TEXT NOT NULL,
  FOREIGN KEY (user_feedback_id) REFERENCES user_feedback(id)
);

CREATE TABLE evaluation_case (
  id TEXT PRIMARY KEY,
  origin_feedback_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  input_snapshot_id TEXT NOT NULL,
  expected_items_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (origin_feedback_id) REFERENCES user_feedback(id),
  FOREIGN KEY (input_snapshot_id) REFERENCES input_snapshot(id)
);

CREATE TABLE evaluation_run (
  id TEXT PRIMARY KEY,
  policy_revision_id TEXT NOT NULL,
  routing_snapshot_json TEXT NOT NULL,
  suite_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  FOREIGN KEY (policy_revision_id) REFERENCES policy_revision(id)
);

CREATE TABLE evaluation_result (
  id TEXT PRIMARY KEY,
  evaluation_run_id TEXT NOT NULL,
  evaluation_case_id TEXT NOT NULL,
  actual_items_json TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  score REAL,
  error_class TEXT,
  FOREIGN KEY (evaluation_run_id) REFERENCES evaluation_run(id),
  FOREIGN KEY (evaluation_case_id) REFERENCES evaluation_case(id),
  UNIQUE (evaluation_run_id, evaluation_case_id)
);

CREATE TABLE improvement_proposal (
  id TEXT PRIMARY KEY,
  trigger_feedback_ids_json TEXT NOT NULL DEFAULT '[]',
  target_type TEXT NOT NULL,
  proposed_diff TEXT NOT NULL,
  expected_effect TEXT,
  evaluation_run_id TEXT,
  status TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (evaluation_run_id) REFERENCES evaluation_run(id)
);

CREATE TABLE sync_run (
  id TEXT PRIMARY KEY,
  requested_from TEXT NOT NULL,
  requested_to TEXT NOT NULL,
  folder_scope_json TEXT NOT NULL,
  status TEXT NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE wiki_revision (
  id TEXT PRIMARY KEY,
  matter_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  change_summary TEXT,
  evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  FOREIGN KEY (matter_id) REFERENCES matter(id),
  UNIQUE (matter_id, version)
);

CREATE INDEX idx_matter_active_ref ON matter(archived_at, our_ref);
CREATE INDEX idx_work_item_matter ON work_item(matter_id, archived_at, updated_at DESC);
CREATE INDEX idx_action_matter ON action_item(matter_id, archived_at, status, due_date);
CREATE INDEX idx_note_matter ON matter_note(matter_id, archived_at, updated_at DESC);
CREATE INDEX idx_event_entity ON event(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_observation_entity ON source_observation(entity_type, entity_id, field_path, observed_at DESC);
CREATE INDEX idx_decision_item_field ON decision_item(subject_type, subject_key, field_path, created_at DESC);

