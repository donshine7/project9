import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareWiki, wikiDetail, wikiIndex, wikiPacket } from '../lib/wiki';
const [directory,...types] = process.argv.slice(2);
if (!directory || !types.length) throw new Error('Usage: new-private-directory entityTypes...');
mkdirSync(directory);
const jobs = [], held = [], unchanged = [];
for (const entry of wikiIndex().filter(e => types.includes(e.type))) {
  const detail = wikiDetail(entry.type,entry.id);
  if (!entry.entryCount) { held.push({type:entry.type,id:entry.id,label:entry.label,reason:'no_admissible_entries'}); continue; }
  if (detail.sourceIssues.length) { held.push({type:entry.type,id:entry.id,label:entry.label,reason:'source_issues'}); continue; }
  if (entry.version && !detail.stale) { unchanged.push({type:entry.type,id:entry.id,label:entry.label}); continue; }
  const run = prepareWiki(entry.type,entry.id);
  const packet = wikiPacket(run.runId);
  jobs.push({type:entry.type,id:entry.id,label:entry.label,...run,packet});
}
const batches = [];
for (let i=0;i<jobs.length;i+=16) {
  const file = path.join(directory,`batch-${batches.length+1}.json`);
  writeFileSync(file,JSON.stringify(jobs.slice(i,i+16),null,2),{flag:'wx'});
  batches.push({file,count:Math.min(16,jobs.length-i)});
}
const manifest={jobs:jobs.map(({packet: _packet,...job})=>job),batches,held,unchanged};
writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
console.log(JSON.stringify({directory,jobs:jobs.length,batches,held:held.length,unchanged:unchanged.length}));
