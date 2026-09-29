import { inspectWikiBatchReadiness } from '../lib/wiki-batch-readiness';

const [databasePath, vaultPath, batchSize] = process.argv.slice(2);
const result = inspectWikiBatchReadiness({
  databasePath: databasePath || undefined,
  vaultPath: vaultPath || undefined,
  batchSize: batchSize ? Number(batchSize) : undefined,
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
