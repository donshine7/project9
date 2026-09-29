import { readFileSync } from 'node:fs';
import { checkpointReadiness, createOperationalCheckpoint, rehearseOperationalRestore, verifyCheckpointDirectory } from '../lib/operational-checkpoint';

function main() {
  const [command, input] = process.argv.slice(2);
  if (!command || !input) throw new Error('사용법: <readiness|checkpoint|verify|rehearse> <request.json|checkpoint-directory>');
  const request = (command === 'readiness' || command === 'checkpoint') ? JSON.parse(readFileSync(input, 'utf8')) : null;
  const result = command === 'readiness' ? checkpointReadiness(request)
    : command === 'checkpoint' ? createOperationalCheckpoint(request)
      : command === 'verify' ? (() => {
        const checked = verifyCheckpointDirectory(input);
        return { checkpoint: checked.checkpoint, operationId: checked.manifest.operationId, databaseSha256: checked.manifest.database.sha256, vaultTreeSha256: checked.manifest.vault.treeSha256, gitHead: checked.manifest.git.head, verifiedFiles: checked.verifiedFiles };
      })()
        : command === 'rehearse' ? rehearseOperationalRestore(JSON.parse(readFileSync(input, 'utf8')))
          : (() => { throw new Error(`알 수 없는 명령: ${command}`); })();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try { main(); } catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
}
