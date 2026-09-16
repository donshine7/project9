import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analysisMailIndex, analysisStatus, applyVerifiedRegistration, bindAnalysis, ingestAnalysis, prepareAnalysis, reviewCandidate } from '../lib/analysis';
import { createMatter, databaseStatus, importOutlookMail, withDatabase } from '../lib/work-db';

const root = mkdtempSync(path.join(os.tmpdir(), 'sspat-registration-'));
process.env.SSPAT_WORK_DB_PATH = path.join(root, 'test.db');
process.chdir(path.resolve(__dirname, '..', '..', 'dashboard'));
try {
  databaseStatus();
  importOutlookMail([{ entryId: 'fixture', folderPath: '사건등록', direction: 'received', subject: '등록 알림', mailAt: '2026-09-16T01:00:00Z', body: '사건등록 업로드 하였습니다.' }], { from: '2026-09-16T00:00:00Z', to: '2026-09-17T00:00:00Z', folders: ['사건등록'] });
  const mailId = String(analysisMailIndex()[0].id);
  const subject = '[사건등록 완료] T261999 / D261999-JP / T261997';
  withDatabase(db => db.prepare('UPDATE mail_item SET subject=? WHERE id=?').run(subject, mailId));
  const start = (op: string) => { const r = prepareAnalysis(op, [mailId]); bindAnalysis(r.runId, { agentId: `fixture-${r.runId}`, model: r.route.model, effort: r.route.effort }); return r.runId; };
  const f = (value: unknown, field: string, quote: string) => ({ value, confidence: 0.97, rationale: '원문 명시', evidence: [{ mailId, field, quote }] });
  const registration = (ref: string, basis = 'registration_mail') => ({ key: ref, kind: 'link', entityType: 'mail', entityId: mailId, fields: { matterRef: f(ref, 'subject', subject), registrationBasis: f(basis, 'body_text', '사건등록 업로드 하였습니다.') } });
  const output = (runId: string, candidates: any[]) => ({ schemaVersion: 1, runId, coverage: [{ mailId, outcome: 'candidate', reason: '후보' }], candidates });
  const run = start('matter_linking');
  assert.throws(() => ingestAnalysis(output(run, [registration('T261998')])), /전체 사건번호/);
  assert.throws(() => ingestAnalysis(output(run, [{ ...registration('T261999'), fields: { ...registration('T261999').fields, registrationBasis: f('mail_inference', 'subject', subject) } }])), /근거 유형/);
  ingestAnalysis(output(run, [registration('T261999'), registration('D261999-JP'), registration('T261997', 'active_matter_mail')]));
  const candidates = analysisStatus().candidates.filter(c => c.run_id === run);
  const t = candidates.find(c => c.payload.fields.matterRef.value === 'T261999')!;
  const d = candidates.find(c => c.payload.fields.matterRef.value === 'D261999-JP')!;
  const active = candidates.find(c => c.payload.fields.matterRef.value === 'T261997')!;
  assert.throws(() => applyVerifiedRegistration(t.id, 'test approval'), /독립 고위험/);
  assert.throws(() => reviewCandidate(t.id, { action: 'accept', expectedVersion: 1 }), /주 작업/);
  const verify = (id: string, verdict: string) => ingestAnalysis(output(start('high_risk_verification'), [{ key: id, kind: 'risk', entityType: 'candidate', entityId: id, fields: { verdict: f(verdict, 'subject', subject) } }]));
  verify(t.id, 'confirmed'); verify(d.id, 'needs_review'); verify(active.id, 'confirmed');
  assert.throws(() => applyVerifiedRegistration(d.id, 'test approval'), /반려·보류/);
  // Stale source must fail without creating anything.
  withDatabase(db => db.prepare('UPDATE mail_item SET subject=? WHERE id=?').run(subject + ' changed', mailId));
  assert.throws(() => applyVerifiedRegistration(t.id, 'test approval'), /원본 메일이 변경/);
  withDatabase(db => db.prepare('UPDATE mail_item SET subject=? WHERE id=?').run(subject, mailId));
  const applied = applyVerifiedRegistration(t.id, 'test approval');
  const activeApplied = applyVerifiedRegistration(active.id, 'test approval');
  assert.equal(applied.duplicate, false);
  assert.equal(applyVerifiedRegistration(t.id, 'test approval').duplicate, true);
  withDatabase(db => {
    const matter = db.prepare('SELECT * FROM matter WHERE id=?').get(applied.matterId)!;
    assert.equal(matter.user_confirmed, 0); assert.equal(matter.source_type, 'registration_mail'); assert.equal(matter.country_code, 'KR');
    const activeMatter = db.prepare('SELECT * FROM matter WHERE id=?').get(activeApplied.matterId)!;
    assert.equal(activeMatter.user_confirmed, 0); assert.equal(activeMatter.source_type, 'mail_inference');
    for (const table of ['user_feedback','work_item','action_item','assignment','matter_party','matter_group','matter_note']) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM mail_matter_link').get()!.n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM source_observation').get()!.n, 8);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
  // New registration must not overwrite an existing user-created matter.
  const freshRun = start('matter_linking');
  assert.throws(() => ingestAnalysis(output(freshRun, [registration('T261999')])), /이미 존재/);
  const dRun = start('matter_linking');
  ingestAnalysis(output(dRun, [registration('D261999-JP')]));
  const newD = analysisStatus().candidates.find(c => c.run_id === dRun)!;
  verify(newD.id, 'confirmed');
  createMatter({ ourRef: 'D261999-JP' });
  assert.throws(() => applyVerifiedRegistration(newD.id, 'test approval'), /덮어쓰지/);
  console.log('Registration tests passed');
} finally { rmSync(root, { recursive: true, force: true }); }
