const { DatabaseSync } = require('node:sqlite');

if (!process.env.SSPAT_WORK_DB_PATH) throw new Error('SSPAT_WORK_DB_PATH is required');
const terms = process.argv.slice(2);
if (!terms.length) throw new Error('Usage: node scripts/Inspect-TrademarkGroupEvidence.cjs SEARCH_TERM...');

const db = new DatabaseSync(process.env.SSPAT_WORK_DB_PATH, { readOnly: true });
const normalize = value => String(value || '').toLocaleLowerCase('ko-KR');
const needles = terms.map(normalize);
const refPattern = /(?:PPT|PT|AT|[PDTS])\d{6}(?:-[A-Z0-9]+(?:\([A-Z-]+\))?)*/gi;
const refLinePattern = /(?:PPT|PT|AT|[PDTS])\d{6}(?:-[A-Z0-9]+(?:\([A-Z-]+\))?)*/i;
const mails = db.prepare('SELECT id,conversation_id,folder_path,direction,subject,sender_name,sender_email,recipients_json,mail_at,body_text FROM mail_item ORDER BY mail_at,id').all();
const matched = mails.filter(mail => {
  const haystack = normalize([mail.subject, mail.sender_name, mail.sender_email, mail.recipients_json, mail.body_text].join('\n'));
  return needles.some(needle => haystack.includes(needle));
}).map(mail => {
  const lines = String(mail.body_text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const evidence = lines.filter(line => {
    const value = normalize(line);
    return needles.some(needle => value.includes(needle)) || refLinePattern.test(line);
  }).slice(0, 120);
  const refs = [...new Set([mail.subject, mail.body_text].flatMap(value => String(value || '').match(refPattern) || []).map(value => value.toUpperCase()))];
  return { ...mail, body_text: undefined, refs, evidence };
});

const trademarkMatters = db.prepare(`
  SELECT m.id,m.our_ref,m.source_type,m.source_id,m.confidence,m.user_confirmed,
         group_concat(DISTINCT CASE WHEN mp.party_type='organization' THEN o.name ELSE p.name END) AS parties
  FROM matter m
  LEFT JOIN matter_party mp ON mp.matter_id=m.id
  LEFT JOIN organization o ON mp.party_type='organization' AND o.id=mp.party_id
  LEFT JOIN person p ON mp.party_type='person' AND p.id=mp.party_id
  WHERE m.archived_at IS NULL AND m.our_ref LIKE 'T%'
  GROUP BY m.id
  ORDER BY m.our_ref
`).all();
const groups = db.prepare(`
  SELECT g.id,g.group_ref,g.group_type,g.representative_matter_id,g.note,
         group_concat(m.our_ref, ', ') AS members
  FROM matter_group g
  LEFT JOIN matter_group_member gm ON gm.group_id=g.id
  LEFT JOIN matter m ON m.id=gm.matter_id
  WHERE g.archived_at IS NULL AND (g.note LIKE '%와이비케이%' OR g.note LIKE '%남기선%' OR g.group_ref LIKE '%와이비케이%' OR g.group_ref LIKE '%남기선%')
  GROUP BY g.id
  ORDER BY g.id
`).all();

console.log(JSON.stringify({ terms, matchedMailCount: matched.length, matched, trademarkMatters, groups }, null, 2));
