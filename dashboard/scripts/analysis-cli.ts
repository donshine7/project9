import { readFileSync, writeFileSync } from 'node:fs';
import { analysisMailIndex, analysisPacket, analysisStatus, bindAnalysis, failAnalysis, ingestAnalysis, prepareAnalysis } from '../lib/analysis';
import { captureVerifiedMail, ingestWiki, prepareWiki, retryRun, reviewWiki, wikiPacket } from '../lib/wiki';
import { auditMailLinks } from '../lib/link-audit';
import { activateSourcePriorityPolicy, recordEasyPatVerification } from '../lib/easypat-verification';
import { createBackup } from '../lib/work-db';

// CLI is the trusted main-task bridge. No browser endpoint accepts forged LLM runs.
const [command, arg, ...rest] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === 'mails') result = analysisMailIndex();
  else if (command === 'link-audit') result = auditMailLinks();
  else if (command === 'status') result = analysisStatus();
  else if (command === 'prepare') result = prepareAnalysis(arg, rest);
  else if (command === 'packet') result = analysisPacket(arg);
  else if (command === 'packet-file') { result = analysisPacket(arg); writeFileSync(rest[0], `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); result = { runId: arg, file: rest[0] }; }
  else if (command === 'bind') result = bindAnalysis(arg, { agentId: rest[0], model: rest[1], effort: rest[2] });
  else if (command === 'ingest') result = ingestAnalysis(JSON.parse(readFileSync(arg, 'utf8').replace(/^\uFEFF/, '')));
  else if (command === 'fail') result = failAnalysis(arg, rest[0]);
  else if (command === 'retry') result = retryRun(arg);
  else if (command === 'wiki-capture') result = captureVerifiedMail(arg, rest[0]);
  else if (command === 'wiki-prepare') result = prepareWiki(arg, rest[0]);
  else if (command === 'wiki-packet') result = wikiPacket(arg);
  else if (command === 'wiki-ingest') result = ingestWiki(JSON.parse(readFileSync(arg, 'utf8').replace(/^\uFEFF/, '')));
  else if (command === 'wiki-publish') result = reviewWiki(arg, 'publish', Number(rest[0]), 'Codex');
  else if (command === 'easypat-record') result = recordEasyPatVerification(JSON.parse(readFileSync(arg, 'utf8').replace(/^\uFEFF/, '')));
  else if (command === 'source-policy-activate') result = { backup: createBackup(), policy: activateSourcePriorityPolicy('장진태') };
  else throw new Error('analysis mails | prepare OP MAIL_ID... | packet RUN_ID | packet-file RUN_ID PATH | bind RUN_ID AGENT_ID MODEL EFFORT | ingest JSON_PATH | fail RUN_ID ERROR_CODE | easypat-record JSON_PATH | source-policy-activate | status');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : '분석 실패'); process.exitCode = 1; }
