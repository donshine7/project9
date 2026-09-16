import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { matterReferenceTokens } from './matter-number';

type Row = Record<string, any>;
type VerifiedReferenceNote = {
  candidateId: string;
  summary: string;
  confidence: number;
  evidence: unknown;
  model: string;
  effort: string;
  createdAt: string;
  verificationModels: string[];
};
// Read-only projection. A verified observation is not a registration or user answer.
export function verifiedReferenceNotes(db: DatabaseSync, mailId: string, reference: string) {
  const mail = db.prepare('SELECT * FROM mail_item WHERE id=?').get(mailId) as Row | undefined;
  if (!mail) return [];
  const mailHash = createHash('sha256').update(JSON.stringify([mail.subject, mail.body_text, mail.sender_name, mail.sender_email, mail.recipients_json, mail.mail_at, mail.direction, mail.conversation_id, mail.folder_path])).digest('hex');
  const facts = db.prepare(`SELECT c.id,c.payload_json,c.created_at,r.model,r.reasoning_effort,s.context_json
    FROM analysis_candidate c JOIN decision_run r ON r.id=c.run_id JOIN input_snapshot s ON s.id=r.input_snapshot_id
    WHERE c.kind='fact' AND c.entity_id=? AND c.review_status IN ('pending','accepted') AND r.status='succeeded'
    ORDER BY c.created_at DESC,c.id`).all(mailId) as Row[];
  const notes: VerifiedReferenceNote[] = [];
  for (const fact of facts) {
    const context = JSON.parse(fact.context_json);
    if (!context.mails.some((m: Row) => m.id === mailId && m.hash === mailHash)) continue;
    const field = JSON.parse(fact.payload_json).fields.summary;
    if (!matterReferenceTokens(field.value).includes(reference)) continue;
    const verifiers = db.prepare(`SELECT v.payload_json,r.model,r.reasoning_effort FROM analysis_candidate v
      JOIN decision_run r ON r.id=v.run_id WHERE v.kind='risk' AND v.entity_id=? AND r.status='succeeded'`).all(fact.id) as Row[];
    if (!verifiers.length || verifiers.some(v => JSON.parse(v.payload_json).fields.verdict.value !== 'confirmed')) continue;
    if (notes.some(n => n.summary === field.value)) continue;
    notes.push({ candidateId: fact.id, summary: field.value, confidence: field.confidence, evidence: field.evidence,
      model: fact.model, effort: fact.reasoning_effort, createdAt: fact.created_at,
      verificationModels: [...new Set(verifiers.map(v => `${v.model} / ${v.reasoning_effort}`))] });
    if (notes.length === 3) break;
  }
  return notes;
}
