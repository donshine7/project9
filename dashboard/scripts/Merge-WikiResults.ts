import { readFileSync, writeFileSync } from 'node:fs';

type Entry = { event_id: string; entry_date: string; provenance: string };
type Job = {
  runId: string;
  packet: { context: { wiki: { entries: Entry[] } } };
};
type Sentence = { text: string; entryDate: string | null; eventIds: string[] };
type Section = { key: string; title: string; sentences: Sentence[] };
type Result = { schemaVersion: number; runId: string; changeSummary: string; sections: Section[] };

const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length || inputs.length % 2 !== 0) {
  throw new Error('Usage: NEW_OUTPUT batch.json result.json [batch.json result.json ...]');
}

const allowed = new Map([
  ['overview', '현재 요약'],
  ['timeline', '날짜별 중요내용'],
  ['issues', '확인할 사항'],
]);
const merged: Result[] = [];
const seen = new Set<string>();

for (let i = 0; i < inputs.length; i += 2) {
  const jobs = JSON.parse(readFileSync(inputs[i], 'utf8')) as Job[];
  const results = JSON.parse(readFileSync(inputs[i + 1], 'utf8')) as Result[];
  const byRun = new Map(results.map(result => [result.runId, result]));
  if (byRun.size !== results.length) throw new Error(`Duplicate result runId: ${inputs[i + 1]}`);
  if (jobs.length !== results.length) throw new Error(`Job/result count mismatch: ${inputs[i]}`);

  for (const job of jobs) {
    const result = byRun.get(job.runId);
    if (!result) throw new Error(`Missing result: ${job.runId}`);
    if (seen.has(job.runId)) throw new Error(`Duplicate job runId: ${job.runId}`);
    if (result.schemaVersion !== 1 || !result.changeSummary?.trim() || !result.sections?.length) {
      throw new Error(`Invalid Wiki result shape: ${job.runId}`);
    }
    const entries = new Map(job.packet.context.wiki.entries.map(entry => [entry.event_id, entry]));
    for (const section of result.sections) {
      if (allowed.get(section.key) !== section.title || !section.sentences?.length) {
        throw new Error(`Invalid or empty section: ${job.runId}/${section.key}`);
      }
      for (const sentence of section.sentences) {
        if (!sentence.text?.trim() || !sentence.eventIds?.length || sentence.eventIds.length > 10) {
          throw new Error(`Invalid sentence: ${job.runId}/${section.key}`);
        }
        const cited = sentence.eventIds.map(eventId => {
          const entry = entries.get(eventId);
          if (!entry) throw new Error(`Unknown event: ${job.runId}/${eventId}`);
          return entry;
        });
        if (section.key === 'timeline' && (!sentence.entryDate || cited.some(entry => entry.entry_date !== sentence.entryDate))) {
          throw new Error(`Timeline date mismatch: ${job.runId}`);
        }
        if (section.key !== 'timeline' && sentence.entryDate !== null) {
          throw new Error(`Non-timeline entryDate must be null: ${job.runId}`);
        }
        if (cited.some(entry => entry.provenance === 'verified_mail') && !sentence.text.includes('메일')) {
          throw new Error(`Verified-mail attribution missing: ${job.runId}`);
        }
      }
    }
    seen.add(job.runId);
    merged.push(result);
  }
}

writeFileSync(output, JSON.stringify(merged, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, results: merged.length }));
