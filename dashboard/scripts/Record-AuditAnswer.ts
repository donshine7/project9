import { analysisStatus } from '../lib/analysis';
import { recordAuditFeedback } from '../lib/audit-feedback';
import { createBackup } from '../lib/work-db';

// Main-task bridge for an actual user answer, not a model-generated disposition.
const [kind, reference, status, answer] = process.argv.slice(2);
if (!answer?.trim()) throw Error('Usage: KIND REFERENCE STATUS EXACT_USER_ANSWER');
const findings = analysisStatus().linkAudit?.findings.filter((f: {kind:string;matterRef:string}) => f.kind === kind && f.matterRef === reference) || [];
if (findings.length !== 1 || !findings[0].decisionId) throw Error('An unambiguous audit question is required');
const backup = createBackup();
console.log(JSON.stringify({backup:backup.file,...recordAuditFeedback(findings[0].decisionId, {status,answer})}));
