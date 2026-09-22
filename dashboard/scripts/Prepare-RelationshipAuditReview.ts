import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { withDatabase } from '../lib/work-db';

const [auditPath, outputDirectory, maxMailsValue = '60'] = process.argv.slice(2);
if (!auditPath || !outputDirectory) throw new Error('Usage: AUDIT_JSON NEW_OUTPUT_DIRECTORY [MAX_MAILS]');
const root = path.resolve(outputDirectory);
if (existsSync(root)) throw new Error('Output directory already exists');
const maxMails = Number(maxMailsValue);
if (!Number.isInteger(maxMails) || maxMails < 10 || maxMails > 200) throw new Error('MAX_MAILS must be an integer from 10 to 200');
mkdirSync(root);

const audit = JSON.parse(readFileSync(path.resolve(auditPath), 'utf8').replace(/^\uFEFF/, ''));
const findings = audit.relationships?.findings as Array<{
  matterId: string;
  matterRef: string;
  mailCount: number;
  latestMailId: string;
}> | undefined;
if (!findings?.length) throw new Error('No relationship findings');

const targets = withDatabase(db => findings.map(finding => {
  const matter = db.prepare('SELECT id,our_ref,row_version FROM matter WHERE id=? AND our_ref=? AND archived_at IS NULL').get(finding.matterId, finding.matterRef) as { id: string; our_ref: string; row_version: number } | undefined;
  if (!matter) throw new Error(`Relationship target is stale: ${finding.matterRef}`);
  const partyCount = (db.prepare('SELECT count(*) n FROM matter_party WHERE matter_id=?').get(matter.id) as { n: number }).n;
  if (partyCount !== 0) throw new Error(`Relationship target already has parties: ${finding.matterRef}`);
  const mails = db.prepare(`
    SELECT mi.id,mi.mail_at,mi.subject,mi.direction,l.match_source,l.confidence
    FROM mail_matter_link l JOIN mail_item mi ON mi.id=l.mail_id
    WHERE l.matter_id=? ORDER BY mi.mail_at,mi.id
  `).all(matter.id) as Array<{ id: string; mail_at: string; subject: string; direction: string; match_source: string; confidence: number }>;
  if (!mails.length) throw new Error(`Relationship target has no linked mail: ${finding.matterRef}`);
  return { ...finding, matter, mails };
}));

type Target = (typeof targets)[number];
const batches: Target[][] = [];
let current: Target[] = [];
let currentMailIds = new Set<string>();
for (const target of targets) {
  const nextIds = new Set([...currentMailIds, ...target.mails.map(mail => mail.id)]);
  if (current.length && nextIds.size > maxMails) {
    batches.push(current);
    current = [];
    currentMailIds = new Set<string>();
  }
  current.push(target);
  for (const mail of target.mails) currentMailIds.add(mail.id);
  if (currentMailIds.size > 200) throw new Error(`Single batch exceeds analysis limit near ${target.matterRef}`);
}
if (current.length) batches.push(current);

const manifest = batches.map((batch, index) => {
  const mailIds = [...new Set(batch.flatMap(target => target.mails.map(mail => mail.id)))];
  const run = prepareAnalysis('matter_linking', mailIds);
  const file = path.join(root, `batch-${index + 1}.json`);
  const packet = {
    ...analysisPacket(run.runId),
    taskScope: {
      kind: 'relationship_coverage_review',
      targets: batch.map(target => ({
        matterId: target.matterId,
        matterRef: target.matterRef,
        linkedMailIds: target.mails.map(mail => mail.id),
      })),
      purpose: '대상 사건별로 직접 명시된 회사·자연인과 사건상 역할만 관계 후보화. 회사 형태는 직접 법인 표기가 없으면 미정, 자연인은 명시된 개인 이메일이 없으면 후보 금지. 메일 링크·사건·상태·Action·그룹 변경 후보는 금지.',
    },
  };
  writeFileSync(file, `${JSON.stringify(packet, null, 2)}\n`, { flag: 'wx' });
  return { ...run, file, targetCount: batch.length, mailCount: mailIds.length, matterRefs: batch.map(target => target.matterRef) };
});

writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ outputDirectory: root, findingCount: targets.length, batchCount: manifest.length, batches: manifest }));
