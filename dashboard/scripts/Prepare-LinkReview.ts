import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { analysisPacket, prepareAnalysis } from '../lib/analysis';
import { auditMailLinks } from '../lib/link-audit';

// Main-task only: stored-mail review, never accesses Outlook or creates matters.
const directory = process.argv[2];
if (!directory) throw Error('Usage: Prepare-LinkReview NEW_PRIVATE_DIRECTORY');
const root = path.resolve(directory);
mkdirSync(root); // Refuse to overwrite an earlier review.
const audit = auditMailLinks();
type AuditFinding = (typeof audit.findings)[number];
const findings = audit.findings.filter((f: AuditFinding) => f.kind === 'missing_link');
const mailIds = [...new Set<string>(findings.map((f: AuditFinding) => String(f.mailId)))];
if (!mailIds.length) throw Error('No missing links');
const run = prepareAnalysis('matter_linking', mailIds);
const packet = analysisPacket(run.runId);
const save = (name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2), { flag: 'wx' });
save('audit-before.json', audit);
save('packet.json', packet);
save('view.json', { ...packet, context: { ...packet.context, candidates: [] }, findings, fullPacket: path.join(root, 'packet.json') });
console.log(JSON.stringify({ ...run, mailCount: mailIds.length, findings: findings.length, directory: root }));
