import { constants, copyFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { analysisStatus, reviewCandidate } from '../lib/analysis';
import { createBackup, withDatabase } from '../lib/work-db';
import { captureAcceptedRelationshipEntries } from '../lib/wiki';
import { auditRelationshipCoverage } from '../lib/relationship-audit';

const [mode, output, ...runIds] = process.argv.slice(2);
if (!['dry-run','apply'].includes(mode) || !output || !runIds.length) throw new Error('Usage: dry-run|apply new-report.json approvedRunIds...');
const backup = createBackup();
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)),`approved-dry-run-${randomUUID()}.db`);
  copyFileSync(backup.file,clone,constants.COPYFILE_EXCL); process.env.SSPAT_WORK_DB_PATH = clone;
}
const protectedTables = ['mail_item','mail_matter_link','matter','matter_note','work_item','assignment','matter_group','matter_group_member'];
const digest = () => withDatabase(db => Object.fromEntries(protectedTables.map(t => [t,createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).digest('hex')])));
const before = digest();
const candidates = analysisStatus().candidates.filter(c => runIds.includes(c.run_id) && ['link','action'].includes(c.kind));
const accepted = [], held = [];
for (const c of candidates) {
  if (c.review_status !== 'pending') { held.push({id:c.id,reason:c.review_status}); continue; }
  if (!c.verifications.length || c.verifications.some((v:{value:string})=>v.value !== 'confirmed')) { held.push({id:c.id,reason:'independent_confirmation_required'}); continue; }
  const result = reviewCandidate(c.id,{action:'accept',expectedVersion:c.row_version,reason:'2026-09-15 사용자가 관계 17건과 검증 통과 Action 후보의 운영 DB 반영을 승인함. 원문·독립 검증 및 최신 버전 검사를 통과한 값만 반영.'});
  accepted.push(result);
}
const relationshipEntries = captureAcceptedRelationshipEntries();
const relationshipAudit = auditRelationshipCoverage();
if (JSON.stringify(before)!==JSON.stringify(digest())) throw new Error('Protected records changed');
const integrity = withDatabase(db=>({check:db.prepare('PRAGMA integrity_check').get(),foreignKeys:db.prepare('PRAGMA foreign_key_check').all()}));
if (JSON.stringify(integrity.check)!=='{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw new Error('Integrity failed');
writeFileSync(output,JSON.stringify({mode,backup:backup.file,clone,accepted,held,relationshipEntries,relationshipAudit,integrity,protectedTablesUnchanged:true},null,2),{flag:'wx'});
console.log(JSON.stringify({mode,output,accepted:accepted.length,held,relationshipEntries,relationshipMissing:relationshipAudit.findingCount,integrity}));
