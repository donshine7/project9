const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const source = readFileSync(
  path.resolve(__dirname, '..', 'scripts', 'Export-OutlookMail.ps1'),
  'utf8',
);

const entryIdRead = source.indexOf('$entryId = [string]$item.EntryID');
const blankEntryIdGuard = source.indexOf(
  'if ([string]::IsNullOrWhiteSpace($entryId)) { continue }',
);
const recordAppend = source.indexOf('$script:records.Add([pscustomobject]@{');

assert.ok(entryIdRead >= 0, 'Outlook EntryID must be read before export');
assert.ok(blankEntryIdGuard > entryIdRead, 'blank Outlook EntryID must be rejected');
assert.ok(recordAppend > blankEntryIdGuard, 'invalid items must be skipped before record append');
assert.match(source, /entryId\s*=\s*\$entryId/);

console.log('Outlook export EntryID guard regression test passed.');
