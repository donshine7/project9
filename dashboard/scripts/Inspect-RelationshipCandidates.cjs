const { DatabaseSync } = require('node:sqlite');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const summary = process.argv.includes('--summary');
const files = process.argv.slice(2).filter(value => value !== '--summary');
if (!files.length) throw new Error('Usage: RESULT_JSON...');
const results = files.map(file => JSON.parse(readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, '')));
const candidates = results.flatMap(result => result.candidates.map(candidate => ({ runId: result.runId, ...candidate })));
const databasePath = process.env.SSPAT_WORK_DB_PATH
  ? path.resolve(process.env.SSPAT_WORK_DB_PATH)
  : path.join(process.env.LOCALAPPDATA, 'SSPAT', 'work-management', 'sspat-work.db');
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const rows = candidates.map(candidate => {
    const values = Object.fromEntries(Object.entries(candidate.fields).map(([key, field]) => [key, field.value]));
    const matter = db.prepare('SELECT id,our_ref,row_version FROM matter WHERE our_ref=? AND archived_at IS NULL').get(values.matterRef);
    const existingParty = values.partyType === 'organization'
      ? db.prepare('SELECT id,name,business_type,row_version,source_type,source_id FROM organization WHERE name=? COLLATE NOCASE AND archived_at IS NULL').all(values.name)
      : db.prepare('SELECT id,name,email,row_version,source_type,source_id FROM person WHERE email=? COLLATE NOCASE AND archived_at IS NULL').all(values.email);
    const existingRelationship = matter ? db.prepare('SELECT * FROM matter_party WHERE matter_id=? AND party_type=? AND party_id IN (SELECT id FROM organization WHERE name=? COLLATE NOCASE UNION SELECT id FROM person WHERE email=? COLLATE NOCASE)').all(matter.id, values.partyType, values.name, values.email) : [];
    return { runId: candidate.runId, candidateKey: candidate.key, entityId: candidate.entityId, values, matter, existingParty, existingRelationship };
  });
  const identityRuns = {};
  for (const row of rows) {
    const key = row.values.partyType === 'organization' ? `organization:${row.values.name.toLowerCase()}` : `person:${row.values.email.toLowerCase()}`;
    identityRuns[key] ||= [];
    identityRuns[key].push({ runId: row.runId, candidateKey: row.candidateKey, matterRef: row.values.matterRef });
  }
  const wikiTargets = [...new Map(rows.flatMap(row => row.existingParty.map(party => [`${row.values.partyType}:${party.id}`, { type: row.values.partyType, id: party.id, name: party.name }]))).values()];
  const output = { databasePath, candidateCount: rows.length, wikiTargets, rows, crossRunIdentities: Object.fromEntries(Object.entries(identityRuns).filter(([, items]) => new Set(items.map(item => item.runId)).size > 1)) };
  console.log(JSON.stringify(summary ? { databasePath, candidateCount: rows.length, wikiTargets, crossRunIdentities: output.crossRunIdentities } : output, null, 2));
} finally {
  db.close();
}
