import { runWikiLegacyArchiveDryRun, verifyWikiLegacyArchive } from '../lib/wiki-legacy-archive';

try {
  const [command, outputRoot] = process.argv.slice(2);
  if (!outputRoot || !['dry-run', 'verify'].includes(command)) throw new Error('사용법: wiki-legacy-archive-cli (dry-run|verify) OUTPUT_ROOT');
  const result = command === 'verify' ? verifyWikiLegacyArchive(outputRoot) : runWikiLegacyArchiveDryRun(outputRoot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
