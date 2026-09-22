import { writeFileSync } from 'node:fs';
import { prepareWiki, wikiDetail, wikiPacket } from '../lib/wiki';

const [output, ...targets] = process.argv.slice(2);
if (!output || !targets.length) throw new Error('Usage: NEW_OUTPUT type:id...');
const jobs = targets.map(target => {
  const separator = target.indexOf(':');
  if (separator < 1) throw new Error(`Invalid target: ${target}`);
  const type = target.slice(0, separator);
  const id = target.slice(separator + 1);
  const detail = wikiDetail(type, id);
  if (!detail.entries.length) throw new Error(`No Wiki entries: ${target}`);
  if (detail.sourceIssues.length) throw new Error(`Wiki source issues: ${target}`);
  if (detail.previous && !detail.stale) throw new Error(`Wiki is current: ${target}`);
  const run = prepareWiki(type, id);
  return { type, id, ...run, packet: wikiPacket(run.runId) };
});
writeFileSync(output, JSON.stringify(jobs, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, jobs: jobs.length, runIds: jobs.map(job => job.runId) }));
