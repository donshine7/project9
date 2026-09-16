import { createHash, randomUUID } from 'node:crypto';
import { transaction, withDatabase } from './work-db';

type Row = Record<string, any>;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Finds matters that have mail evidence but no confirmed organization/person
// relationship. It deliberately does not infer a name or legal role.
export function auditRelationshipCoverage() {
  return withDatabase(db => transaction(db, () => {
    const matters = db.prepare('SELECT id,our_ref,row_version FROM matter WHERE archived_at IS NULL ORDER BY id').all() as Row[];
    const mails = db.prepare('SELECT id,subject,mail_at,direction,sender_name,sender_email,body_hash FROM mail_item ORDER BY id').all() as Row[];
    const links = db.prepare('SELECT mail_id,matter_id,match_source,confidence FROM mail_matter_link ORDER BY mail_id,matter_id').all() as Row[];
    const parties = db.prepare('SELECT matter_id,party_type,party_id,role FROM matter_party ORDER BY matter_id,party_type,party_id,role').all() as Row[];
    const context = { version: 'relationship-coverage-audit-v1', matters, mails, links, parties };
    const contextHash = hash(context);
    const prior = db.prepare("SELECT r.id,r.result_json FROM decision_run r JOIN input_snapshot s ON s.id=r.input_snapshot_id WHERE r.operation='relationship_coverage_audit' AND r.status='succeeded' AND s.context_hash=? LIMIT 1").get(contextHash) as Row | undefined;
    if (prior) return { ...JSON.parse(prior.result_json), duplicate: true };

    const findings = matters.flatMap(matter => {
      if (parties.some(party => party.matter_id === matter.id)) return [];
      const evidence = links.filter(link => link.matter_id === matter.id).map(link => mails.find(mail => mail.id === link.mail_id)).filter(Boolean) as Row[];
      if (!evidence.length) return [];
      evidence.sort((a, b) => String(b.mail_at).localeCompare(String(a.mail_at)));
      return [{
        matterId: matter.id,
        matterRef: matter.our_ref,
        mailCount: evidence.length,
        latestMailId: evidence[0].id,
        latestMailAt: evidence[0].mail_at,
        latestSubject: evidence[0].subject,
        reason: '연결된 메일은 있으나 확정된 회사·자연인 관계가 없습니다. 메일에 직접 적힌 대상과 역할을 별도 검증해야 합니다.',
      }];
    }).sort((a, b) => String(b.latestMailAt).localeCompare(String(a.latestMailAt)) || a.matterRef.localeCompare(b.matterRef));

    const timestamp = new Date().toISOString(), runId = randomUUID(), snapshotId = randomUUID();
    const result = { runId, matterCount: matters.length, linkedMailCount: links.length, confirmedRelationshipCount: parties.length, findingCount: findings.length, findings, createdAt: timestamp };
    db.prepare("INSERT INTO input_snapshot(id,mail_ids_json,entity_versions_json,source_priority_version,context_hash,context_json,created_at) VALUES (?,?,?,'confirmed-relationship-v1',?,?,?)")
      .run(snapshotId, JSON.stringify(mails.map(mail => mail.id)), JSON.stringify(Object.fromEntries(matters.map(matter => [`matter:${matter.id}`, matter.row_version]))), contextHash, JSON.stringify(context), timestamp);
    db.prepare("INSERT INTO decision_run(id,operation,agent_name,prompt_version,routing_snapshot_json,input_snapshot_id,status,started_at,completed_at,output_hash,result_json) VALUES (?,'relationship_coverage_audit','deterministic_relationship_auditor','relationship-coverage-audit-v1','{\"method\":\"deterministic\",\"model\":null,\"effort\":null}',?,'succeeded',?,?,?,?)")
      .run(runId, snapshotId, timestamp, timestamp, hash(result), JSON.stringify(result));
    for (const finding of findings) {
      const decisionId = randomUUID(), value = JSON.stringify(finding);
      db.prepare("INSERT INTO decision_item(id,decision_run_id,subject_type,subject_key,field_path,decision_type,proposed_value_json,normalized_value_json,confidence,risk_level,rationale,review_status,created_at) VALUES (?,?,'matter',?,'parties.coverage','review',?,?,1,'medium',?,'not_reviewed',?)")
        .run(decisionId, runId, finding.matterRef, value, value, finding.reason, timestamp);
      db.prepare("INSERT INTO decision_evidence(id,decision_item_id,source_type,source_id,locator_json,excerpt,excerpt_hash,supports) VALUES (?,?,'mail',?,'{\"field\":\"subject\"}',?,?,'context')")
        .run(randomUUID(), decisionId, finding.latestMailId, finding.latestSubject, createHash('sha256').update(finding.latestSubject).digest('hex'));
    }
    return { ...result, duplicate: false };
  }));
}
