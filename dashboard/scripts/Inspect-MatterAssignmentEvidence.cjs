const { DatabaseSync } = require('node:sqlite');

if (!process.env.SSPAT_WORK_DB_PATH) throw new Error('SSPAT_WORK_DB_PATH is required');
const compact = process.argv.includes('--compact');
const refs = process.argv.slice(2).filter(value => value !== '--compact');
if (!refs.length || refs.some(ref => !/^[A-Z0-9()\-]+$/.test(ref))) {
  throw new Error('Usage: node scripts/Inspect-MatterAssignmentEvidence.cjs MATTER_REF...');
}

const db = new DatabaseSync(process.env.SSPAT_WORK_DB_PATH, { readOnly: true });
const result = refs.map(ourRef => {
  const matter = db.prepare('SELECT * FROM matter WHERE our_ref=? COLLATE NOCASE').get(ourRef);
  if (!matter) return { ourRef, matter: null, mails: [], works: [], actions: [], decisions: [] };

  const linked = db.prepare(`
    SELECT mi.*
    FROM mail_item mi
    JOIN mail_matter_link l ON l.mail_id=mi.id
    WHERE l.matter_id=?
    ORDER BY mi.mail_at,mi.id
  `).all(matter.id);
  const conversationIds = [...new Set(linked.map(mail => mail.conversation_id).filter(Boolean))];
  const conversationMails = conversationIds.length
    ? db.prepare(`SELECT * FROM mail_item WHERE conversation_id IN (${conversationIds.map(() => '?').join(',')}) ORDER BY mail_at,id`).all(...conversationIds)
    : [];
  const mailById = new Map([...linked, ...conversationMails].map(mail => [mail.id, mail]));

  const works = db.prepare('SELECT * FROM work_item WHERE matter_id=? ORDER BY created_at,id').all(matter.id)
    .map(work => ({
      ...work,
      assignments: db.prepare('SELECT * FROM assignment WHERE work_item_id=? ORDER BY role,id').all(work.id),
    }));
  const actions = db.prepare('SELECT * FROM action_item WHERE matter_id=? ORDER BY created_at,id').all(matter.id);
  const mails = [...mailById.values()].sort((a, b) => a.mail_at.localeCompare(b.mail_at) || a.id.localeCompare(b.id));
  const mailIds = mails.map(mail => mail.id);
  const decisions = mailIds.length
    ? db.prepare(`
        SELECT di.*,dr.operation,dr.status AS run_status
        FROM decision_item di
        JOIN decision_run dr ON dr.id=di.decision_run_id
        WHERE di.subject_key IN (${mailIds.map(() => '?').join(',')})
        ORDER BY di.created_at,di.id
      `).all(...mailIds)
    : [];
  const outputMails = compact ? mails.map(mail => ({
    id: mail.id,
    conversation_id: mail.conversation_id,
    direction: mail.direction,
    subject: mail.subject,
    sender_name: mail.sender_name,
    sender_email: mail.sender_email,
    recipients_json: mail.recipients_json,
    mail_at: mail.mail_at,
    evidence_lines: [...new Set(mail.body_text.split(/\r?\n/).map(line => line.trim()).filter(line => line && /(담당|업무|요청|회신|답변|진행|의견|보정|OA|분할|미수|청구|마감|제출|장진태|박준호|황현우|백기상)/i.test(line)))].slice(0, 40),
  })) : mails;
  return { ourRef, matter, mails: outputMails, works, actions, decisions };
});

console.log(JSON.stringify(result, null, 2));
