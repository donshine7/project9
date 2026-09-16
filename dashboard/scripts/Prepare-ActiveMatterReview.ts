import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { auditMailLinks } from '../lib/link-audit';

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw Error('Usage: NEW_PRIVATE_DIRECTORY');
mkdirSync(root);
const excluded = new Set(['PT261204','PT261205','PT261206','PT261207','PT261208','PT261209','PT261210','PT261211','PT261212','PT261213','T261435','T261436','T261437','T261438','T261439']);
const audit = auditMailLinks();
type AuditFinding = (typeof audit.findings)[number];
const findings = audit.findings.filter((f: AuditFinding) => f.kind === 'unregistered_ref' && !excluded.has(String(f.matterRef)));
const mailIds = [...new Set<string>(findings.map((f: AuditFinding) => String(f.mailId)))];
const run = prepareAnalysis('matter_linking', mailIds);
const packet = analysisPacket(run.runId);
for (const [name, value] of Object.entries({ packet, audit, view: { ...packet, context: { ...packet.context, candidates: [] }, findings, excludedRefs: [...excluded] } })) {
  writeFileSync(path.join(root, `${name}.json`), JSON.stringify(value, null, 2), { flag: 'wx' });
}
console.log(JSON.stringify({ ...run, directory: root, findings: findings.length, references: new Set(findings.map((f: AuditFinding) => f.matterRef)).size, excluded: excluded.size }));
