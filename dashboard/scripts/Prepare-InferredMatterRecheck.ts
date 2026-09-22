import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { withDatabase } from '../lib/work-db';

const [matterRef, output] = process.argv.slice(2);
if (!matterRef || !output) throw new Error('Usage: MATTER_REF NEW_PACKET_JSON');
if (existsSync(output)) throw new Error('Packet already exists');

const scope = withDatabase(db => {
  const matter = db.prepare('SELECT * FROM matter WHERE our_ref=? AND archived_at IS NULL').get(matterRef) as (Record<string, unknown> & { id: string }) | undefined;
  if (!matter) throw new Error(`Active matter not found: ${matterRef}`);
  const mails = db.prepare(`
    SELECT mi.id, mi.subject, mi.mail_at, l.match_source, l.confidence
    FROM mail_matter_link l
    JOIN mail_item mi ON mi.id=l.mail_id
    WHERE l.matter_id=?
    ORDER BY mi.mail_at, mi.id
  `).all(matter.id) as Array<{ id: string }>;
  if (!mails.length) throw new Error(`No linked mail: ${matterRef}`);
  return { matter, mails };
});

const run = prepareAnalysis('high_risk_verification', scope.mails.map(mail => mail.id));
const packet = {
  ...analysisPacket(run.runId),
  taskScope: {
    kind: 'inferred_matter_archive_recheck',
    matter: scope.matter,
    linkedMails: scope.mails,
    purpose: '앞선 단일 메일 보관 판단을 전체 연결 메일로 재검증한다. 현재 비인용 메일이 해당 전체 관리번호의 실질 업무를 직접 나타내면 keep, 자동 알림·과거 인용만이면 archive를 제안한다.',
  },
};
writeFileSync(path.resolve(output), `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ ...run, matterRef, mailCount: scope.mails.length, output: path.resolve(output) }));
