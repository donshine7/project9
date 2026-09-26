import { approveWikiAutoApply, executeWikiAutoApply, recoverWikiAutoApply, wikiAutoApplyStatus } from '../lib/wiki-auto-apply';

async function main() {
  const [command, id, value] = process.argv.slice(2);
  if (command === 'approve') return approveWikiAutoApply(id, Number(value));
  if (command === 'apply') return executeWikiAutoApply(id, { confirmation: value });
  if (command === 'recover') return recoverWikiAutoApply(id);
  if (command === 'status') return wikiAutoApplyStatus(id);
  throw new Error('사용법: wiki-auto-apply-cli approve PROPOSAL_ID ROW_VERSION | apply PROPOSAL_ID APPLY | recover OPERATION_ID | status OPERATION_ID');
}

main().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
