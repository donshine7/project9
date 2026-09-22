const { DatabaseSync } = require('node:sqlite');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const [importReportPath, auditReportPath, outputPath] = process.argv.slice(2);
if (!importReportPath || !auditReportPath || !outputPath) {
  throw new Error('Usage: node Inspect-PostGapMatterAudit.cjs IMPORT_REPORT AUDIT_REPORT OUTPUT');
}
const readJson = (file) => JSON.parse(readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''));
const importReport = readJson(importReportPath);
const auditReport = readJson(auditReportPath);
const mailIds = [...new Set(importReport.newMailIds || [])];
if (!mailIds.length) throw new Error('Import report has no newMailIds');

const databasePath = process.env.SSPAT_WORK_DB_PATH
  ? path.resolve(process.env.SSPAT_WORK_DB_PATH)
  : path.join(process.env.LOCALAPPDATA, 'SSPAT', 'work-management', 'sspat-work.db');
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  const placeholders = mailIds.map(() => '?').join(',');
  const inferredMatters = db.prepare(`
    SELECT m.id,m.our_ref,m.office,m.matter_kind,m.country_code,m.base_ref,m.suffixes_json,
           m.source_type,m.source_id,m.confidence,m.user_confirmed,m.created_at,
           mi.direction,mi.folder_path,mi.subject,mi.sender_email,mi.mail_at,
           substr(mi.body_text,1,5000) AS body_excerpt,
           (SELECT COUNT(*) FROM mail_matter_link l WHERE l.matter_id=m.id) AS linked_mail_count
    FROM matter m
    JOIN mail_item mi ON mi.id=m.source_id
    WHERE m.source_id IN (${placeholders})
    ORDER BY m.our_ref
  `).all(...mailIds);
  const findings = auditReport.numberAudit?.findings || [];
  const byKind = Object.fromEntries([...new Set(findings.map((finding) => finding.kind))].sort().map((kind) => {
    const selected = findings.filter((finding) => finding.kind === kind);
    return [kind, {
      findingCount: selected.length,
      uniqueRefs: [...new Set(selected.map((finding) => finding.matterRef))].sort(),
      mailIds: [...new Set(selected.map((finding) => finding.mailId))].sort(),
    }];
  }));
  const result = {
    databasePath,
    importedMailCount: mailIds.length,
    inferredMatterCount: inferredMatters.length,
    inferredMatters,
    numberAudit: {
      runId: auditReport.numberAudit?.runId,
      findingCount: findings.length,
      byKind,
    },
  };
  writeFileSync(path.resolve(outputPath), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({
    output: path.resolve(outputPath),
    importedMailCount: mailIds.length,
    inferredMatterCount: inferredMatters.length,
    auditFindingCount: findings.length,
    kinds: Object.fromEntries(Object.entries(byKind).map(([kind, value]) => [kind, {
      findingCount: value.findingCount,
      uniqueRefs: value.uniqueRefs.length,
    }])),
  }));
} finally {
  db.close();
}
