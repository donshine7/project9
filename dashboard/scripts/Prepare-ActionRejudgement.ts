import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { withDatabase } from '../lib/work-db';

type MailRow = { id: string; conversation_id: string | null; mail_at: string; chars: number };
type Group = { key: string; mails: MailRow[]; chars: number };

const output = path.resolve(process.argv[2] || '');
const requestedBatches = Number(process.argv[3] || 4);
if (!process.argv[2] || !Number.isInteger(requestedBatches) || requestedBatches < 1) {
  throw new Error('Usage: NEW_PRIVATE_DIRECTORY [BATCH_COUNT]');
}
mkdirSync(output);

const source = withDatabase(db => {
  const linked = db.prepare(`
    SELECT mi.id, mi.conversation_id, mi.mail_at,
           length(mi.subject) + length(mi.body_text) + length(mi.recipients_json) AS chars
    FROM mail_item mi
    WHERE EXISTS (SELECT 1 FROM mail_matter_link link WHERE link.mail_id = mi.id)
    ORDER BY mi.mail_at, mi.id
  `).all() as MailRow[];
  return {
    linked,
    totalMailCount: Number((db.prepare('SELECT COUNT(*) AS count FROM mail_item').get() as { count: number }).count),
    unlinkedMailCount: Number((db.prepare(`
      SELECT COUNT(*) AS count FROM mail_item mi
      WHERE NOT EXISTS (SELECT 1 FROM mail_matter_link link WHERE link.mail_id = mi.id)
    `).get() as { count: number }).count),
    activeActions: db.prepare(`
      SELECT action.id, matter.our_ref, action.title, action.assignee, action.manager,
             action.status, action.due_date, action.priority, action.row_version
      FROM action_item action JOIN matter ON matter.id = action.matter_id
      WHERE action.archived_at IS NULL
      ORDER BY matter.our_ref, action.created_at
    `).all(),
    actionCandidateCounts: db.prepare(`
      SELECT review_status, COUNT(*) AS count
      FROM analysis_candidate WHERE kind = 'action'
      GROUP BY review_status ORDER BY review_status
    `).all(),
  };
});

const grouped = new Map<string, MailRow[]>();
for (const mail of source.linked) {
  const key = mail.conversation_id || `mail:${mail.id}`;
  grouped.set(key, [...(grouped.get(key) || []), mail]);
}
const groups: Group[] = [...grouped].map(([key, mails]) => ({
  key,
  mails,
  chars: mails.reduce((sum, mail) => sum + Number(mail.chars || 0), 0),
}));
if (groups.some(group => group.mails.length > 200)) throw new Error('A conversation exceeds the 200-mail run limit');

const batchCount = Math.min(requestedBatches, groups.length);
const bins = Array.from({ length: batchCount }, (_, index) => ({ index, groups: [] as Group[], mails: 0, chars: 0 }));
for (const group of groups.sort((a, b) => b.chars - a.chars || b.mails.length - a.mails.length || a.key.localeCompare(b.key))) {
  const eligible = bins.filter(bin => bin.mails + group.mails.length <= 200);
  if (!eligible.length) throw new Error('Unable to preserve conversations within the 200-mail run limit');
  eligible.sort((a, b) => a.chars - b.chars || a.mails - b.mails || a.index - b.index);
  eligible[0].groups.push(group);
  eligible[0].mails += group.mails.length;
  eligible[0].chars += group.chars;
}

const created = bins.map((bin, index) => {
  const mails = bin.groups.flatMap(group => group.mails).sort((a, b) => a.mail_at.localeCompare(b.mail_at) || a.id.localeCompare(b.id));
  const run = prepareAnalysis('action_judgement', mails.map(mail => mail.id));
  const file = path.join(output, `batch-${index + 1}.json`);
  writeFileSync(file, JSON.stringify({
    ...analysisPacket(run.runId),
    taskScope: {
      asOf: new Date().toISOString(),
      purpose: '전체 저장 메일 중 사건 연결이 확정된 대화와 보낸 회신을 기준으로 장진태·팀원 Action을 다시 판정한다.',
      rules: [
        '기존 미완료 Action과 같은 업무는 새 후보를 만들지 않는다.',
        '후속 회신이 요청의 완료 또는 담당 범위 밖임을 보이면 새 Action을 만들지 않는다.',
        '팀원 Action도 장진태 화면에 표시되고 상태 변경자는 장진태다.',
        'CC 메일은 승인·관리·재배분·기한 통제가 필요한 경우에만 Action 후보로 삼는다.',
        '메일에 적힌 날짜를 법정기일 계산 결과로 확정하지 않는다.',
        '현재 완료를 추정하거나 기존 Action을 자동 완료하지 않는다.',
      ],
      activeActions: source.activeActions,
      priorActionCandidateCounts: source.actionCandidateCounts,
      batch: { index: index + 1, count: batchCount, mailCount: mails.length, conversationCount: bin.groups.length },
    },
  }, null, 2), { flag: 'wx' });
  return { ...run, file, mailCount: mails.length, conversationCount: bin.groups.length, chars: bin.chars };
});

const manifest = {
  totalMailCount: source.totalMailCount,
  analysedMailCount: source.linked.length,
  unlinkedMailCount: source.unlinkedMailCount,
  unlinkedReason: 'Action 후보는 확정된 사건 연결이 필요하므로 미연결 메일은 후보 생성 대상에서 제외한다.',
  conversationCount: groups.length,
  activeActionCount: source.activeActions.length,
  priorActionCandidateCounts: source.actionCandidateCounts,
  batches: created,
};
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify(manifest));
