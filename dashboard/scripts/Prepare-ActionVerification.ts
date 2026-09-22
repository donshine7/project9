import { writeFileSync } from 'node:fs';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { withDatabase } from '../lib/work-db';

const [output, ...sourceRunIds] = process.argv.slice(2);
if (!output || !sourceRunIds.length) throw new Error('Usage: NEW_OUTPUT SOURCE_ACTION_RUN_ID...');

const targets = withDatabase(db => db.prepare(`
  SELECT * FROM analysis_candidate
  WHERE run_id IN (${sourceRunIds.map(() => '?').join(',')})
    AND kind = 'action' AND review_status = 'pending'
  ORDER BY created_at, id
`).all(...sourceRunIds).map((candidate: any) => ({ ...candidate, payload: JSON.parse(candidate.payload_json) })));
if (!targets.length) throw new Error('No pending Action candidates');
const targetIds = new Set(targets.map(candidate => candidate.id));
const matterIds = [...new Set(targets.map(candidate => candidate.entity_id))];
const evidenceMailIds = [...new Set(targets.flatMap(candidate =>
  Object.values(candidate.payload.fields).flatMap((field: any) => field.evidence.map((evidence: any) => evidence.mailId)),
))];

const mailIds = withDatabase(db => {
  const conversationIds = evidenceMailIds
    .map(id => (db.prepare('SELECT conversation_id FROM mail_item WHERE id=?').get(id) as { conversation_id: string | null } | undefined)?.conversation_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const selected = db.prepare(`
    SELECT DISTINCT mail.id, mail.mail_at
    FROM mail_item mail
    LEFT JOIN mail_matter_link link ON link.mail_id = mail.id
    WHERE mail.id IN (${evidenceMailIds.map(() => '?').join(',')})
       OR mail.conversation_id IN (${conversationIds.map(() => '?').join(',') || "''"})
       OR link.matter_id IN (${matterIds.map(() => '?').join(',')})
    ORDER BY mail.mail_at, mail.id
  `).all(...evidenceMailIds, ...conversationIds, ...matterIds) as Array<{ id: string }>;
  return selected.map(mail => mail.id);
});
if (mailIds.length > 200) throw new Error(`Verification scope exceeds 200 mails: ${mailIds.length}`);

const run = prepareAnalysis('high_risk_verification', mailIds);
const packet = analysisPacket(run.runId);
const focused = {
  ...packet,
  targetCandidates: packet.context.candidates.filter((candidate: { id: string }) => targetIds.has(candidate.id)),
  taskScope: {
    sourceRunIds,
    targetCount: targets.length,
    purpose: 'Action 후보의 필요성·담당자·제목·기한·우선순위 전체와 기존 Action 중복, 후속 회신에 따른 종결 여부를 독립 검증한다.',
  },
};
if (focused.targetCandidates.length !== targets.length) throw new Error('Target candidates are not fully present in the verification snapshot');
writeFileSync(output, JSON.stringify(focused, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...run, targetCount: targets.length, mailCount: mailIds.length, output }));
