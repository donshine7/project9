-- Existing groups stay unclassified; series suffixes do not confirm membership.
ALTER TABLE matter_group ADD COLUMN group_type TEXT NOT NULL DEFAULT '미분류' CHECK(length(trim(group_type)) BETWEEN 1 AND 100);
