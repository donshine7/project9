import assert from 'node:assert/strict';
import { readApiObject } from '../lib/api-response';

async function main() {
  const reply = (payload: unknown, ok = true) => ({ ok, json: async () => payload });
  assert.deepEqual(await readApiObject(reply({ projects: [] })), { projects: [] });
  await assert.rejects(readApiObject(reply({ error: '저장 충돌' }, false)), /저장 충돌/);
  await assert.rejects(readApiObject(reply({ error: { message: '잘못된 오류' } }, false)), /요청을 처리하지/);
  for (const invalid of [null, [], '오류', 123]) {
    await assert.rejects(readApiObject(reply(invalid)), /응답 형식/);
  }
  const broken = { ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } };
  await assert.rejects(readApiObject(broken), /응답을 읽지/);
  await assert.rejects(readApiObject({ ...broken, ok: false }, '초기화 실패'), /초기화 실패/);
  console.log('Client HTTP status, JSON shape and error-response checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
