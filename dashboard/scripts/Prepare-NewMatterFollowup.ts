import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { withDatabase } from '../lib/work-db';

const [directory, ...matterRefs] = process.argv.slice(2);
if (!directory || !matterRefs.length) throw new Error('Usage: NEW_PRIVATE_DIRECTORY MATTER_REF...');
if (new Set(matterRefs).size !== matterRefs.length) throw new Error('Duplicate matter references');

const root = path.resolve(directory);
mkdirSync(root);
const scope = withDatabase(db => matterRefs.map(ourRef => {
  const matter = db.prepare('SELECT id,our_ref,row_version FROM matter WHERE our_ref=? AND archived_at IS NULL').get(ourRef) as { id: string; our_ref: string; row_version: number } | undefined;
  if (!matter) throw new Error(`Matter not found: ${ourRef}`);
  const mailIds = (db.prepare('SELECT mail_id FROM mail_matter_link WHERE matter_id=? ORDER BY mail_id').all(matter.id) as Array<{ mail_id: string }>).map(row => row.mail_id);
  if (!mailIds.length) throw new Error(`No linked mail: ${ourRef}`);
  const actions = db.prepare("SELECT id,title,assignee,status,due_date,priority,row_version FROM action_item WHERE matter_id=? AND archived_at IS NULL ORDER BY created_at").all(matter.id);
  const parties = db.prepare('SELECT party_type,party_id,role FROM matter_party WHERE matter_id=? ORDER BY party_type,party_id,role').all(matter.id);
  return { matter, mailIds, actions, parties };
}));
const mailIds = [...new Set(scope.flatMap(item => item.mailIds))];
const save = (name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), { flag: 'wx' });

const actionRun = prepareAnalysis('action_judgement', mailIds);
const relationshipRun = prepareAnalysis('matter_linking', mailIds);
save('actions.json', { ...analysisPacket(actionRun.runId), taskScope: { matters: scope, purpose: '신규 사건의 현재 미완료 Action만 판정. 보낸 회신과 현재 문맥으로 이미 해결된 요청은 제외.' } });
save('relationships.json', { ...analysisPacket(relationshipRun.runId), taskScope: { matters: scope, purpose: '메일에 직접 명시된 회사·자연인과 역할만 후보화. 회사 형태와 자연인 이메일을 계약대로 분리.' } });
save('manifest.json', { actionRun, relationshipRun, matterRefs, mailIds });
console.log(JSON.stringify({ actionRun, relationshipRun, matterRefs, mailCount: mailIds.length, directory: root }));
