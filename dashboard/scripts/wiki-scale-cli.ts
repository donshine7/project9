import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assessWikiScaleReadiness, inspectOperationalWikiReadiness } from '../lib/wiki-scale';

function output(value: unknown, file?: string) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (file) {
    const target = path.resolve(file);
    if (existsSync(target)) throw new Error(`기존 보고서를 덮어쓰지 않습니다: ${target}`);
    writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' });
  }
  process.stdout.write(text);
}

async function main() {
  const [command, report] = process.argv.slice(2);
  if (command === 'assess') return output(await assessWikiScaleReadiness(), report);
  if (command === 'operational-readiness') return output(inspectOperationalWikiReadiness(), report);
  throw new Error('사용법: wiki-scale-cli <assess|operational-readiness> [REPORT.json]');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
