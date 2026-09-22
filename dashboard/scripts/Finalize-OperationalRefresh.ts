import { constants, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createBackup, withDatabase } from '../lib/work-db';
import {
  completeWorkRefreshStage,
  finalizeWorkRefresh,
  getWorkRefresh,
  recordWorkRefreshResult,
  startWorkRefreshStage,
} from '../lib/work-refresh';

type Row = Record<string, any>;
const [mode, output, rehearsalPath, refreshId, wikiCountValue, ...runIds] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !output || !rehearsalPath || !refreshId || !wikiCountValue || !runIds.length) {
  throw new Error('Usage: dry-run|apply NEW_REPORT REHEARSAL_OR_DASH REFRESH_ID WIKI_COUNT CANDIDATE_RUN_IDS...');
}
const wikiCount = Number(wikiCountValue);
if (!Number.isSafeInteger(wikiCount) || wikiCount < 0) throw new Error('Invalid Wiki count');

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const candidateRows = () => withDatabase(db => db.prepare(`
  SELECT id,run_id,kind,entity_id,payload_json,review_status,applied_event_id,row_version
  FROM analysis_candidate
  WHERE kind IN ('fact','link','action') AND run_id IN (${runIds.map(() => '?').join(',')})
  ORDER BY created_at,id
`).all(...runIds) as Row[]);
const sourceState = () => ({ refresh: getWorkRefresh(refreshId), candidates: candidateRows() });
const sourceHash = digest(sourceState());
const protectedTables = ['mail_item','matter','mail_matter_link','work_item','assignment','action_item','matter_note','organization','person','matter_group','matter_group_member','matter_party','user_feedback','knowledge_entry','wiki_entry','entity_wiki_revision'];
const protectedState = () => withDatabase(db => Object.fromEntries(protectedTables.map(table => [table, digest(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())])));
const protectedBefore = digest(protectedState());
const backup = createBackup();
let clone: string | null = null;
if (mode === 'dry-run') {
  clone = path.join(path.dirname(path.resolve(output)), `finalize-refresh-dry-${randomUUID()}.db`);
  copyFileSync(backup.file, clone, constants.COPYFILE_EXCL);
  process.env.SSPAT_WORK_DB_PATH = clone;
} else {
  const rehearsal = JSON.parse(readFileSync(rehearsalPath, 'utf8')) as { mode: string; sourceHash: string; protectedDataUnchanged: boolean };
  if (rehearsal.mode !== 'dry-run' || !rehearsal.protectedDataUnchanged || rehearsal.sourceHash !== sourceHash) {
    throw new Error('Operational refresh or candidates changed since rehearsal');
  }
}

const wikiStage = startWorkRefreshStage(refreshId, 'wiki_revision', wikiCount);
completeWorkRefreshStage(wikiStage.id, {
  processedCount: wikiCount,
  outputCount: wikiCount,
  result: { publishedWikiRevisions: wikiCount, source: 'verified_mail_entries' },
});

const candidates = candidateRows();
const applicationStage = startWorkRefreshStage(refreshId, 'application', candidates.length);
let applied = 0;
let held = 0;
for (const candidate of candidates) {
  const payload = JSON.parse(candidate.payload_json);
  const evidence = Object.values(payload.fields ?? {}).flatMap((field: any) => field.evidence ?? []);
  const mailId = String(evidence[0]?.mailId ?? (candidate.kind === 'fact' || candidate.kind === 'link' ? candidate.entity_id : ''));
  if (!mailId) throw new Error(`Candidate ${candidate.id} has no source mail`);
  const outcome = ['accepted', 'edited'].includes(String(candidate.review_status)) ? 'applied' : 'held';
  if (outcome === 'applied') applied += 1; else held += 1;
  recordWorkRefreshResult(refreshId, {
    stageId: applicationStage.id,
    subjectType: 'candidate',
    subjectKey: candidate.id,
    outcome,
    sourceType: 'mail',
    sourceId: mailId,
    eventId: candidate.applied_event_id ?? undefined,
    result: { kind: candidate.kind, reviewStatus: candidate.review_status, sourceRunId: candidate.run_id },
  });
}
completeWorkRefreshStage(applicationStage.id, {
  processedCount: candidates.length,
  outputCount: applied,
  result: { candidateCount: candidates.length, applied, held },
});
const final = finalizeWorkRefresh(refreshId);
if (protectedBefore !== digest(protectedState())) throw new Error('Business or Wiki records changed during refresh finalization');
const integrity = withDatabase(db => ({ check: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all() }));
if (JSON.stringify(integrity.check) !== '{"integrity_check":"ok"}' || integrity.foreignKeys.length) throw new Error('Integrity failed');

const report = {
  mode, output, backup: backup.file, clone, refreshId, sourceHash,
  wikiStageId: wikiStage.id, applicationStageId: applicationStage.id,
  candidateCount: candidates.length, applied, held, final,
  protectedDataUnchanged: true, integrity,
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ mode, output, candidateCount: candidates.length, applied, held, finalStatus: final.status, pendingMailCount: final.pendingMailCount, integrity }));
