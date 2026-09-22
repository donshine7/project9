import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';

const [scopePath, outputDirectory] = process.argv.slice(2);
if (!scopePath || !outputDirectory) throw new Error('Usage: SCOPE_JSON NEW_OUTPUT_DIRECTORY');
const scope = JSON.parse(readFileSync(path.resolve(scopePath), 'utf8').replace(/^\uFEFF/, ''));
const root = path.resolve(outputDirectory);
mkdirSync(root);

const prepare = (name: string, mailIds: string[], taskScope: unknown) => {
  const uniqueMailIds = [...new Set<string>(mailIds)];
  const run = prepareAnalysis('matter_linking', uniqueMailIds);
  const file = path.join(root, `${name}.json`);
  writeFileSync(file, JSON.stringify({ ...analysisPacket(run.runId), taskScope }, null, 2), { flag: 'wx' });
  return { ...run, file };
};

const inferred = prepare(
  'inferred',
  scope.inferredMatters.map((matter: { source_id: string }) => matter.source_id),
  {
    kind: 'inferred_matter_validation',
    matters: scope.inferredMatters,
    purpose: '메일 수집기가 자동 생성한 사건별로 현재 메시지의 직접 전체번호인지, 인용 이력·범위 확장·다른 사건번호인지 판정. 사건별 keep 또는 archive 제안만 반환하고 신규 링크·사건 후보는 만들지 않음.',
  },
);

const unregistered = scope.numberAudit.byKind.unregistered_ref;
const registration = prepare(
  'registration',
  unregistered.mailIds,
  {
    kind: 'unregistered_ref',
    findings: unregistered,
    purpose: '현재 메시지가 사건등록 완료 또는 해당 번호의 실질 현재 업무를 직접 나타내는 전체 관리번호만 신규 사건 후보로 제안. 과거 인용·묶음 범위·사용자 제외 번호는 제안 금지.',
  },
);

const missing = scope.numberAudit.byKind.missing_link;
const unknown = scope.numberAudit.byKind.unknown_pattern;
const reference = prepare(
  'reference',
  [...missing.mailIds, ...unknown.mailIds],
  {
    kind: 'missing_link_and_unknown_pattern',
    missingFindings: missing,
    unknownFindings: unknown,
    purpose: '기존 사건의 실제 현재 메일 연결 누락만 matterRef 단일필드 후보로 제안. 인용 이력·기초번호·외부 참조번호·이메일 로컬파트·표시 범위는 후보 없이 분류.',
  },
);

const manifest = { inferred, registration, reference };
writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
console.log(JSON.stringify(manifest));
