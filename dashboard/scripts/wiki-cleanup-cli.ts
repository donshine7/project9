import { runWikiLegacyCleanupDryRun } from '../lib/wiki-cleanup';

try {
  const [command, outputRoot] = process.argv.slice(2);
  if (command !== 'dry-run' || !outputRoot) throw new Error('사용법: wiki-cleanup-cli dry-run OUTPUT_ROOT');
  process.stdout.write(`${JSON.stringify(runWikiLegacyCleanupDryRun(outputRoot), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
