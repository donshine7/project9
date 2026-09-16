import { copyFileSync, constants, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { analysisStatus, ingestAnalysis } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';
import { captureVerifiedMail } from '../lib/wiki';
import { hasExactMatterReference, matterReferenceTokens } from '../lib/matter-number';

const [command, source, mode] = process.argv.slice(2);
if (!['ingest', 'capture'].includes(command) || !source || !['dry-run', 'apply'].includes(mode)) throw new Error('Usage: Operate-FactReview ingest <result.json> dry-run|apply OR capture <new-report.json> dry-run|apply');
const backup = createBackup();
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(source)), `dry-run-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
}
const protectedTables = ['mail_item','matter','work_item','assignment','action_item','matter_note','organization','person','matter_group','matter_party','mail_matter_link'];
const digest = () => withDatabase(db => Object.fromEntries(protectedTables.map(table => [table, createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).digest('hex')])));
const before = digest();
let result: unknown;
if (command === 'ingest') {
  result = ingestAnalysis(JSON.parse(readFileSync(source, 'utf8').replace(/^\uFEFF/, '')));
} else {
  const facts = analysisStatus().candidates.filter(c => c.kind === 'fact' && ['pending','accepted'].includes(c.review_status));
  const captured = [], held = [];
  for (const candidate of facts) {
    if (!candidate.verifications.length || candidate.verifications.some((v: { value: string }) => v.value !== 'confirmed')) continue;
    const summary = candidate.payload.fields.summary.value as string;
    const refs = [...new Set(matterReferenceTokens(summary))];
    const targets = withDatabase(db => db.prepare('SELECT m.id,m.our_ref,mail.subject FROM mail_matter_link l JOIN matter m ON m.id=l.matter_id JOIN mail_item mail ON mail.id=l.mail_id WHERE l.mail_id=? AND m.archived_at IS NULL').all(candidate.entity_id)) as Array<{id:string;our_ref:string;subject:string}>;
    const matched = targets.filter(t => hasExactMatterReference(t.subject,t.our_ref) && hasExactMatterReference(summary,t.our_ref));
    // Do not copy a multi-matter summary into every linked matter. Split and verify it separately.
    const singleTitle = matched.length === 1 && new Set(matterReferenceTokens(matched[0].subject)).size === 1;
    const compressedScope = /(?:\d|\))\s*외|[·~～]\s*(?:S\d|P(?:T)?\d)/i.test(summary + ' ' + (matched[0]?.subject || ''));
    if (refs.length !== 1 || matched.length !== 1 || targets.length !== 1 || !singleTitle || compressedScope) { held.push({ candidateId:candidate.id, reason:'single_exact_matter_required', refs }); continue; }
    const entry = captureVerifiedMail(candidate.id, matched[0].id);
    captured.push({candidateId:candidate.id,matterRef:matched[0].our_ref,...entry});
  }
  result = {created:captured.filter(c => !c.duplicate).length,duplicates:captured.filter(c => c.duplicate).length,captured,held};
}
const after = digest();
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Protected business records changed; stop and inspect backup.');
const integrity = withDatabase(db => ({ integrity:db.prepare('PRAGMA integrity_check').get(), foreignKeys:db.prepare('PRAGMA foreign_key_check').all() }));
if (JSON.stringify(integrity.integrity) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw new Error('Database integrity failed');
const report = {command,mode,backup:backup.file,clone,result,protectedTablesUnchanged:true,integrity};
if (command === 'capture') writeFileSync(source,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify(command === 'capture' ? {...report,result:{created:(result as {created:number}).created,duplicates:(result as {duplicates:number}).duplicates,reportFile:source}} : report,null,2));
