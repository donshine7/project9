import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: INPUT_VIEW OUTPUT_COMPACT');
const view = JSON.parse(readFileSync(input, 'utf8'));
const byMail = new Map<string, any[]>();
for (const finding of view.findings) {
  const list = byMail.get(finding.mailId) || [];
  list.push({ matterRef: finding.matterRef, sourceField: finding.sourceField, evidenceExcerpt: finding.evidenceExcerpt });
  byMail.set(finding.mailId, list);
}
const compact = {
  schemaVersion: view.schemaVersion,
  runId: view.runId,
  operation: view.operation,
  route: view.route,
  instructions: 'Original immutable packet is packet.json. Quotes must be literal substrings from these retained fields.',
  excludedRefs: view.excludedRefs,
  mails: view.mails.map((mail: any) => {
    const findings = byMail.get(mail.id) || [];
    return { id: mail.id, mail_at: mail.mail_at, direction: mail.direction, sender_name: mail.sender_name, sender_email: mail.sender_email, subject: mail.subject, findings };
  }),
};
writeFileSync(output, JSON.stringify(compact, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ mails: compact.mails.length, findings: view.findings.length, output }));
