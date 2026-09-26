import { readFileSync } from 'node:fs';
import { executeWikiCutover, rehearseWikiRecovery, wikiCutoverRun, type WikiCutoverRequest } from '../lib/wiki-cutover';

async function main() {
  const [command, first, second] = process.argv.slice(2);
  let result: unknown;
  if (command === 'cutover') {
    if (!first) throw new Error('사용법: wiki:cutover -- cutover <request.json>');
    const request = JSON.parse(readFileSync(first, 'utf8').replace(/^\uFEFF/, '')) as WikiCutoverRequest;
    result = await executeWikiCutover(request);
  } else if (command === 'rehearse') {
    if (!first || !second) throw new Error('사용법: wiki:cutover -- rehearse <cutover-run-id> <restore-root>');
    result = rehearseWikiRecovery(first, second);
  } else if (command === 'status') {
    if (!first) throw new Error('사용법: wiki:cutover -- status <cutover-run-id>');
    result = wikiCutoverRun(first);
  } else {
    throw new Error('명령은 cutover, rehearse, status 중 하나여야 합니다.');
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
