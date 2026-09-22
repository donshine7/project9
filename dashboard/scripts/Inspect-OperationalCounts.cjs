const { DatabaseSync } = require('node:sqlite');

if (!process.env.SSPAT_WORK_DB_PATH) throw new Error('SSPAT_WORK_DB_PATH is required');
const db = new DatabaseSync(process.env.SSPAT_WORK_DB_PATH, { readOnly: true });
const tables = [
  'mail_item',
  'matter',
  'mail_matter_link',
  'matter_party',
  'action_item',
  'wiki_entry',
  'entity_wiki_revision',
];
const counts = Object.fromEntries(
  tables.map(table => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]),
);
const unfinished = db
  .prepare("SELECT COUNT(*) AS count FROM decision_run WHERE status IN ('prepared','started')")
  .get().count;
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
const foreignKeys = db.prepare('PRAGMA foreign_key_check').all().length;

console.log(JSON.stringify({ counts, unfinished, integrity, foreignKeys }));
