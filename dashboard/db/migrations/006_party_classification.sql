-- A party is either a natural person (`person`) or a company (`organization`).
-- Company legal form is separately user-reviewable and defaults to unknown.
ALTER TABLE organization ADD COLUMN business_type TEXT NOT NULL DEFAULT '미정'
  CHECK(business_type IN ('개인사업자', '법인', '미정'));

PRAGMA optimize;
