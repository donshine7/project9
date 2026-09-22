const { DatabaseSync } = require('node:sqlite');

if (!process.env.SSPAT_WORK_DB_PATH) throw new Error('SSPAT_WORK_DB_PATH is required');

const refs = [
  'P241750-RE', 'PT241172', 'PT241173', 'T241498', 'T241499',
  'P241667', 'P241667-DIV1', 'P241667-DIV2', 'PT241110', 'PT241111', 'PT241112',
  'T251093', 'T251094',
];
const db = new DatabaseSync(process.env.SSPAT_WORK_DB_PATH, { readOnly: true });
const placeholders = refs.map(() => '?').join(',');
const matters = db.prepare(`
  SELECT id,our_ref,office,matter_kind,source_type,source_id,confidence,user_confirmed,row_version
  FROM matter
  WHERE archived_at IS NULL AND our_ref IN (${placeholders})
  ORDER BY our_ref
`).all(...refs);
const groups = db.prepare(`
  SELECT g.id,g.group_ref,g.group_type,g.representative_matter_id,r.our_ref AS representative_ref,
         g.note,g.row_version,group_concat(m.our_ref, ', ') AS members
  FROM matter_group g
  LEFT JOIN matter r ON r.id=g.representative_matter_id
  LEFT JOIN matter_group_member gm ON gm.group_id=g.id
  LEFT JOIN matter m ON m.id=gm.matter_id
  WHERE g.archived_at IS NULL AND (g.group_ref='GP241667' OR g.note LIKE '%와이비케이%' OR g.note LIKE '%남기선%')
  GROUP BY g.id
  ORDER BY g.group_ref
`).all();
const decisions = db.prepare(`
  SELECT d.id,d.subject_type,d.subject_key,d.field_path,d.proposed_value_json,
         d.normalized_value_json,d.rationale,d.review_status,d.created_at,r.operation
  FROM decision_item d
  JOIN decision_run r ON r.id=d.decision_run_id
  WHERE d.subject_type='group'
    AND (d.proposed_value_json LIKE '%와이비케이%' OR d.proposed_value_json LIKE '%남기선%'
      OR d.normalized_value_json LIKE '%P241750%' OR d.normalized_value_json LIKE '%P241667%'
      OR d.rationale LIKE '%와이비케이%' OR d.rationale LIKE '%남기선%')
  ORDER BY d.created_at,d.id
`).all();
const feedback = db.prepare(`
  SELECT f.id,f.decision_item_id,f.feedback_action,f.final_value_json,f.note,f.created_at
  FROM user_feedback f
  WHERE f.final_value_json LIKE '%P241750%' OR f.final_value_json LIKE '%P241667%'
     OR f.note LIKE '%와이비케이%' OR f.note LIKE '%남기선%'
  ORDER BY f.created_at,f.id
`).all();
const candidateReviews = db.prepare(`
  SELECT d.id,d.subject_key,d.field_path,d.proposed_value_json,d.normalized_value_json,
         d.rationale,d.review_status,d.created_at,r.id AS run_id,r.operation
  FROM decision_item d
  JOIN decision_run r ON r.id=d.decision_run_id
  WHERE r.operation='group_candidate_review'
  ORDER BY d.created_at,d.id
`).all();

console.log(JSON.stringify({ refs, matters, groups, decisions, feedback, candidateReviews }, null, 2));
