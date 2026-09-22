const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const compact = process.argv.includes('--compact');
const summary = process.argv.includes('--summary');
const refs = process.argv.slice(2).filter((value) => !['--compact', '--summary'].includes(value));
if (!refs.length) throw new Error('Usage: node scripts/Inspect-PaymentActionFollowup.cjs REF...');

const databasePath = process.env.SSPAT_WORK_DB_PATH
  ? path.resolve(process.env.SSPAT_WORK_DB_PATH)
  : path.join(process.env.LOCALAPPDATA, 'SSPAT', 'work-management', 'sspat-work.db');
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const placeholders = refs.map(() => '?').join(',');
  const matters = db.prepare(`SELECT * FROM matter WHERE our_ref IN (${placeholders}) ORDER BY our_ref`).all(...refs);
  const result = matters.map((matter) => ({
    matter,
    relatedMailMatches: db.prepare(`
      SELECT id, folder_path, direction, subject, sender_name, sender_email,
             mail_at, substr(body_text, 1, 1200) AS body_excerpt, body_hash
      FROM mail_item
      WHERE subject LIKE ? OR body_text LIKE ?
      ORDER BY mail_at, id
    `).all(`%${matter.our_ref}%`, `%${matter.our_ref}%`),
    links: db.prepare(`
      SELECT l.*, mi.folder_path, mi.direction, mi.subject, mi.sender_name,
             mi.sender_email, mi.mail_at, mi.body_text, mi.body_hash
      FROM mail_matter_link l
      JOIN mail_item mi ON mi.id = l.mail_id
      WHERE l.matter_id = ?
      ORDER BY mi.mail_at, mi.id
    `).all(matter.id),
    actions: db.prepare(`
      SELECT * FROM action_item
      WHERE matter_id = ?
      ORDER BY created_at, id
    `).all(matter.id),
    wiki: db.prepare(`
      SELECT * FROM wiki_entry
      WHERE entity_type = 'matter' AND entity_id = ?
      ORDER BY entry_date, created_at, id
    `).all(matter.id),
    candidates: db.prepare(`
      SELECT * FROM analysis_candidate
      WHERE entity_id = ?
         OR entity_id IN (SELECT mail_id FROM mail_matter_link WHERE matter_id = ?)
      ORDER BY created_at, id
    `).all(matter.id, matter.id).map((candidate) => ({
      ...candidate,
      verifications: db.prepare(`
        SELECT id, run_id, payload_json, review_status, created_at
        FROM analysis_candidate
        WHERE kind = 'risk' AND entity_id = ?
        ORDER BY created_at, id
      `).all(candidate.id),
    })),
  }));
  if (summary) {
    const output = result.map((item) => {
      const actionCandidates = item.candidates.filter((candidate) => candidate.kind === 'action');
      const latestRevision = db.prepare(`
        SELECT version, change_summary, created_at
        FROM entity_wiki_revision
        WHERE entity_type = 'matter' AND entity_id = ?
        ORDER BY version DESC, created_at DESC
        LIMIT 1
      `).get(item.matter.id);
      return {
        matter: { id: item.matter.id, our_ref: item.matter.our_ref },
        matchedMailCount: item.relatedMailMatches.length,
        matchedMails: item.relatedMailMatches.map((mail) => ({
          id: mail.id,
          direction: mail.direction,
          folder_path: mail.folder_path,
          subject: mail.subject,
          sender_email: mail.sender_email,
          mail_at: mail.mail_at,
        })),
        linkedMailCount: item.links.length,
        linkedMails: item.links.map((mail) => ({
          id: mail.mail_id,
          match_source: mail.match_source,
          confidence: mail.confidence,
          subject: mail.subject,
          mail_at: mail.mail_at,
        })),
        actionCount: item.actions.length,
        wikiEntryCount: item.wiki.length,
        latestRevision: latestRevision || null,
        actionCandidates: actionCandidates.map((candidate) => ({
          id: candidate.id,
          review_status: candidate.review_status,
          latestVerifications: candidate.verifications.map((verification) => {
            const payload = JSON.parse(verification.payload_json);
            return {
              id: verification.id,
              run_id: verification.run_id,
              verdict: payload.fields?.verdict?.value || null,
              confidence: payload.fields?.verdict?.confidence ?? null,
            };
          }),
        })),
      };
    });
    console.log(JSON.stringify({
      databasePath,
      totals: {
        actions: db.prepare(`SELECT COUNT(*) AS n FROM action_item WHERE archived_at IS NULL`).get().n,
        wikiEntries: db.prepare(`SELECT COUNT(*) AS n FROM wiki_entry`).get().n,
        wikiRevisions: db.prepare(`SELECT COUNT(*) AS n FROM entity_wiki_revision`).get().n,
      },
      integrity: db.prepare(`PRAGMA integrity_check`).get(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_check`).all(),
      matters: output,
    }, null, 2));
    return;
  }
  const output = compact ? result.map((item) => ({
    matter: { id: item.matter.id, our_ref: item.matter.our_ref },
    relatedMailMatches: item.relatedMailMatches.map((mail) => ({
      id: mail.id,
      folder_path: mail.folder_path,
      direction: mail.direction,
      subject: mail.subject,
      sender_email: mail.sender_email,
      mail_at: mail.mail_at,
    })),
    actions: item.actions,
    wiki: item.wiki,
    candidates: item.candidates.map((candidate) => ({
      id: candidate.id,
      run_id: candidate.run_id,
      candidate_key: candidate.candidate_key,
      kind: candidate.kind,
      review_status: candidate.review_status,
      row_version: candidate.row_version,
      payload: JSON.parse(candidate.payload_json),
      verifications: candidate.verifications.map((verification) => ({
        id: verification.id,
        run_id: verification.run_id,
        review_status: verification.review_status,
        payload: JSON.parse(verification.payload_json),
      })),
    })),
  })) : result;
  console.log(JSON.stringify({ databasePath, matters: output }, null, 2));
} finally {
  db.close();
}
