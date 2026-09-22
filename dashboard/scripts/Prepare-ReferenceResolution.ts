import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { auditMailLinks } from '../lib/link-audit';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: NEW_PRIVATE_DIRECTORY');
const root = path.resolve(directory);
mkdirSync(root);
const audit = auditMailLinks();
type Finding = (typeof audit.findings)[number];
const prepare = (kind: 'missing_link' | 'unknown_pattern', name: string, purpose: string) => {
  const findings = audit.findings.filter((finding: Finding) => finding.kind === kind);
  const mailIds: string[] = [...new Set<string>(findings.map((finding: Finding) => String(finding.mailId)))];
  if (!mailIds.length) return null;
  const run = prepareAnalysis('matter_linking', mailIds);
  const packet = analysisPacket(run.runId);
  const value = { ...packet, taskScope: { kind, findings, purpose } };
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' });
  return { ...run, file, findingCount: findings.length, uniqueRefs: new Set(findings.map((finding: Finding) => finding.matterRef)).size };
};
const missing = prepare('missing_link', 'missing', '기존 사건과 메일의 실제 연결 누락만 제안. 현재 메시지와 인용 이력·이메일 주소·다른 사건을 구분. 신규 사건·별칭·축약 연결 금지.');
const unknown = prepare('unknown_pattern', 'unknown', '각 문자열이 당소관리번호인지 외부 참조번호·이메일 로컬파트·표시용 범위 표현인지 분류. 유효한 기존 전체 사건번호가 아니면 후보 없이 no_change.');
const manifest = { missing, unknown };
writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify(manifest));
