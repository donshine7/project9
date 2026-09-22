import { readFileSync } from 'node:fs';
import {
  ingestWikiMarkdownProposal,
  prepareWikiMarkdownProposal,
  reconcileWikiMarkdownProposal,
  reviewWikiMarkdownProposal,
  wikiMarkdownProposalDetail,
  wikiMarkdownProposalPacket,
} from '../lib/wiki-proposal';

async function main() {
  const [command, id, ...rest] = process.argv.slice(2);
  let result: unknown;
  if (command === 'prepare') result = await prepareWikiMarkdownProposal(id, rest[0]);
  else if (command === 'packet') result = wikiMarkdownProposalPacket(id);
  else if (command === 'ingest') result = await ingestWikiMarkdownProposal(JSON.parse(readFileSync(id, 'utf8').replace(/^\uFEFF/, '')));
  else if (command === 'reconcile') result = await reconcileWikiMarkdownProposal(id);
  else if (command === 'review') result = await reviewWikiMarkdownProposal(id, rest[0] as 'accept_for_manual_apply' | 'reject', Number(rest[1]), rest[2] || '장진태');
  else if (command === 'detail') result = wikiMarkdownProposalDetail(id);
  else throw new Error('prepare DOC_ID [RETRY_OF] | packet RUN_ID | ingest JSON_PATH | reconcile PROPOSAL_ID | review PROPOSAL_ID ACTION EXPECTED_VERSION [REVIEWER] | detail PROPOSAL_ID');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
