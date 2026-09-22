import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analysisMailIndex, analysisStatus, bindAnalysis, failAnalysis, ingestAnalysis, prepareAnalysis } from '../lib/analysis';
import { addWikiEntry, captureVerifiedMail, ingestWiki, prepareWiki, retryRun, reviewWiki, wikiDetail, wikiEvidence, wikiIndex, wikiPacket } from '../lib/wiki';
import { createBackup, createMatter, createMatterGroup, createOrganization, createPerson, databaseStatus, getMatter, importOutlookMail, restoreBackup, updateEntityNote, withDatabase } from '../lib/work-db';

const temp = mkdtempSync(path.join(os.tmpdir(),'sspat-phase4-'));
process.env.SSPAT_WORK_DB_PATH = path.join(temp,'test.db');
process.chdir(path.resolve(__dirname,'..','..','dashboard'));
try {
  assert.ok(databaseStatus().migrations.length >= 5);
  let matter = createMatter({ourRef:'P260002',note:'수동 비고'});
  const matterId = String(matter.matter.id);
  matter = createOrganization(matterId,{name:'회귀시험 회사'});
  matter = createPerson(matterId,{name:'회귀시험 담당자',email:'fixture@example.com'});
  matter = createMatterGroup(matterId,{groupRef:'GP260002'});
  const targets = [['matter',matterId],['organization',String(matter.organizations[0].id)],['person',String(matter.people[0].id)],['group',String(matter.groups[0].id)]];
  function entry(type:string,id:string,content='회의에서 도면 확인을 요청했다.') { return addWikiEntry(type,id,{content,entryDate:'2026-09-11',expectedVersion:wikiDetail(type,id).entity.row_version}); }
  function start(type:string,id:string) { const run=prepareWiki(type,id); bindAnalysis(run.runId,{agentId:`fixture-${run.runId}`,model:run.route.model,effort:run.route.effort}); return run.runId; }
  function result(runId:string) {
    const source=wikiPacket(runId).context.wiki.entries[0];
    return {schemaVersion:1,runId,changeSummary:'기록 반영',sections:[{key:'timeline',title:'날짜별 중요내용',sentences:[{text:source.content,entryDate:source.entry_date,eventIds:[source.event_id]}]}]};
  }
  assert.throws(()=>prepareWiki('matter',matterId),/먼저 날짜별/);
  assert.throws(()=>addWikiEntry('matter',matterId,{content:'저장되면 안 됨',entryDate:'2026-09-11',expectedVersion:0}),/대상이 변경/);
  for (const [type,id] of targets) {
    const e=entry(type,id);
    assert.equal(wikiEvidence(e.eventId).entry.entity_type,type);
    const runId=start(type,id), output=result(runId);
    const bad=structuredClone(output); bad.sections[0].sentences[0].eventIds=['missing'];
    assert.throws(()=>ingestWiki(bad),/입력에 없는/);
    assert.equal(wikiDetail(type,id).drafts.length,0);
    const badDate=structuredClone(output); badDate.sections[0].sentences[0].entryDate='2026-09-10';
    assert.throws(()=>ingestWiki(badDate),/날짜별 문장/);
    ingestWiki(output); assert.equal(ingestWiki(output).duplicate,true);
    assert.throws(()=>ingestWiki({...output,changeSummary:'덮어쓰기'}),/덮어쓸/);
    reviewWiki(runId,'publish',1);
    assert.equal(wikiDetail(type,id).revisions.length,1);
    assert.equal(reviewWiki(runId,'publish',1).duplicate,true);
    assert.equal(wikiDetail(type,id).stale,false);
  }
  assert.equal(wikiIndex().length,4);
  for (let i=0;i<201;i+=1) createMatter({ourRef:`P27${String(i).padStart(4,'0')}`});
  createMatter({ourRef:'T999999'});
  assert.equal(wikiIndex().length,206);
  assert.ok(wikiIndex().some(item=>item.type==='matter' && item.label==='T999999'));
  assert.equal(getMatter(matterId).matter.note,'수동 비고');
  const first=wikiDetail('matter',matterId).entries[0];
  const staleRun=start('matter',matterId); ingestWiki(result(staleRun));
  addWikiEntry('matter',matterId,{content:'확인 요청은 취소되었다.',entryDate:'2026-09-11',expectedVersion:wikiDetail('matter',matterId).entity.row_version,supersedesId:first.id});
  assert.equal(wikiDetail('matter',matterId).entries.length,1);
  assert.equal(wikiEvidence(first.event_id).entry.content,'회의에서 도면 확인을 요청했다.');
  assert.throws(()=>addWikiEntry('matter',matterId,{content:'중복 정정',entryDate:'2026-09-11',expectedVersion:wikiDetail('matter',matterId).entity.row_version,supersedesId:first.id}),/이미 수정/);
  assert.equal(wikiDetail('matter',matterId).stale,true);
  assert.throws(()=>reviewWiki(staleRun,'publish',1),/변경되었습니다/);
  const retry=retryRun(staleRun);
  bindAnalysis(retry.runId,{agentId:'fixture-retry',model:retry.route.model,effort:retry.route.effort});
  ingestWiki(result(retry.runId)); reviewWiki(retry.runId,'publish',1);
  const versions=wikiDetail('matter',matterId).revisions;
  assert.equal(versions.length,2);
  assert.match(versions[0].sections[0].sentences[0].text,/취소/);
  assert.match(versions[1].sections[0].sentences[0].text,/요청/);
  const mismatch=start('matter',matterId); ingestWiki(result(mismatch));
  const current=wikiDetail('matter',matterId).entity;
  updateEntityNote('matter',matterId,'나중에 수정한 비고',current.row_version);
  assert.throws(()=>reviewWiki(mismatch,'publish',1),/변경되었습니다/);
  reviewWiki(mismatch,'reject',1);
  const failed=prepareWiki('matter',matterId); failAnalysis(failed.runId,'FIXTURE_FAILURE');
  const resumed=retryRun(failed.runId); assert.notEqual(resumed.runId,failed.runId);
  const backup=createBackup();
  entry('matter',matterId,'백업 후 시험 기록');
  const beforeRestore=wikiDetail('matter',matterId).entries.length;
  restoreBackup(backup.file,'RESTORE');
  assert.equal(wikiDetail('matter',matterId).entries.length,beforeRestore-1);
  assert.equal(wikiDetail('matter',matterId).revisions.length,2);
  withDatabase(db=>{
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
    assert.ok(db.prepare('SELECT id FROM user_feedback WHERE feedback_action=?').all('create_missing').length>=4);
    assert.ok(db.prepare('EXPLAIN QUERY PLAN SELECT * FROM wiki_entry WHERE entity_type=? AND entity_id=? ORDER BY entry_date DESC').all('matter',matterId).some((r:any)=>String(r.detail).includes('idx_wiki_entry_entity')));
  });
  // Even a legacy prefix link plus a confirmed factual summary cannot capture
  // the foreign case's observation into the shorter domestic case's Wiki.
  importOutlookMail([{entryId:'opaque-wiki',folderPath:'받은 편지함',direction:'received',subject:'P260002-CN(PA) 요청',body:'P260002-CN(PA) 위임장 요청 메일입니다.',mailAt:'2026-09-11T00:00:00Z'}],{from:'2026-09-11',to:'2026-09-12',folders:['받은 편지함']});
  const mailId=String((analysisMailIndex()[0] as any).id);
  withDatabase(db=>db.prepare("INSERT INTO mail_matter_link(mail_id,matter_id,match_source,confidence,created_at) VALUES (?,?,'subject',0.85,?)").run(mailId,matterId,new Date().toISOString()));
  const startAnalysis=(op:string)=>{const r=prepareAnalysis(op,[mailId]);bindAnalysis(r.runId,{agentId:`fixture-${r.runId}`,model:r.route.model,effort:r.route.effort});return r.runId;};
  const field=(value:string)=>({value,confidence:0.95,rationale:'메일 문구 확인',evidence:[{mailId,field:'body_text',quote:'P260002-CN(PA) 위임장 요청 메일입니다.'}]});
  const factRun=startAnalysis('mail_fact_extraction');
  const coverage=[{mailId,outcome:'candidate',reason:'원문 사실 검토'}];
  ingestAnalysis({schemaVersion:1,runId:factRun,coverage,candidates:[{key:'opaque',kind:'fact',entityType:'mail',entityId:mailId,fields:{summary:field('P260002-CN(PA) 위임장 요청 메일입니다.')}}]});
  const fact=analysisStatus().candidates.find(c=>c.run_id===factRun)!;
  ingestAnalysis({schemaVersion:1,runId:startAnalysis('high_risk_verification'),coverage,candidates:[{key:'verified',kind:'risk',entityType:'candidate',entityId:fact.id,fields:{verdict:field('confirmed')}}]});
  assert.throws(()=>captureVerifiedMail(fact.id,matterId),/전체 관리번호/);
  // A verified body-only full reference is valid when the exact target matter is linked.
  const bodyMatter=createMatter({ourRef:'D261999-JP'});
  const bodyMatterId=String(bodyMatter.matter.id);
  importOutlookMail([{entryId:'body-ref-wiki',folderPath:'보낸 편지함',direction:'sent',subject:'일본 디자인 사건 정보',body:'Design Application Your Ref. D261999-JP 도면을 송부했습니다.',mailAt:'2026-09-11T01:00:00Z'}],{from:'2026-09-11',to:'2026-09-12',folders:['보낸 편지함']});
  const bodyMailId=String(analysisMailIndex().find((m:any)=>m.subject==='일본 디자인 사건 정보')!.id);
  const bodyStart=(op:string)=>{const r=prepareAnalysis(op,[bodyMailId]);bindAnalysis(r.runId,{agentId:`fixture-${r.runId}`,model:r.route.model,effort:r.route.effort});return r.runId;};
  const bodyField=(value:string)=>({value,confidence:0.95,rationale:'본문 전체번호 확인',evidence:[{mailId:bodyMailId,field:'body_text',quote:'Design Application Your Ref. D261999-JP 도면을 송부했습니다.'}]});
  const bodyRun=bodyStart('mail_fact_extraction');
  const bodyCoverage=[{mailId:bodyMailId,outcome:'candidate',reason:'본문 사건 사실'}];
  ingestAnalysis({schemaVersion:1,runId:bodyRun,coverage:bodyCoverage,candidates:[{key:'body-ref',kind:'fact',entityType:'mail',entityId:bodyMailId,fields:{summary:bodyField('D261999-JP 도면 송부 메일이다.')}}]});
  const bodyFact=analysisStatus().candidates.find(c=>c.run_id===bodyRun)!;
  ingestAnalysis({schemaVersion:1,runId:bodyStart('high_risk_verification'),coverage:bodyCoverage,candidates:[{key:'body-verified',kind:'risk',entityType:'candidate',entityId:bodyFact.id,fields:{verdict:bodyField('confirmed')}}]});
  assert.equal(captureVerifiedMail(bodyFact.id,bodyMatterId).duplicate,false);
  console.log('Phase 4: four entity types, evidence, append-only corrections, exact citations, stale draft blocking, revisions, retry and backup/restore passed.');
} finally { rmSync(temp,{recursive:true,force:true}); }
