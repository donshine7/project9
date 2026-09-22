import path from 'node:path';
import { runLegacyWikiMigrationDryRun } from '../lib/wiki-migration';

function value(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} 인수가 필요합니다.`);
  return process.argv[index + 1];
}

try {
  const outputRoot = path.resolve(value('--output-root'));
  const versionIndex = process.argv.indexOf('--conversion-version');
  const version = versionIndex >= 0 ? process.argv[versionIndex + 1] : undefined;
  const result = runLegacyWikiMigrationDryRun(outputRoot, version);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
