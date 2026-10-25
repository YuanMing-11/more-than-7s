import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryBank } from '../src/memory.mjs';
import { loadBank, saveBank } from '../src/storage.mjs';

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'more-than-7s-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('restart restores all scopes and preserves a corrected preference; forgotten memory stays gone', async t => {
  const dir = await workspace(t), path = join(dir, 'memory.json');
  const bank = await loadBank(path);
  assert.deepEqual(bank.scopes(), []);
  const alice = bank.remember({ scope: 'alice', kind: 'preference', key: 'comfort', text: '开启小猫模式。', source: '叫它小猫模式吧。' });
  bank.remember({ scope: 'bob', kind: 'episode', text: '今天面试结束。', source: '面试终于结束了。' });
  await saveBank(path, bank);
  const restarted = await loadBank(path);
  assert.deepEqual(restarted.export('alice'), bank.export('alice'));
  assert.deepEqual(restarted.export('bob'), bank.export('bob'));
  restarted.revise(alice.id, '先问我想如何被陪伴。', { scope: 'alice', source: '下次先问我。' });
  await saveBank(path, restarted);
  const revised = await loadBank(path);
  assert.equal(revised.list('alice')[0].source, '下次先问我。');
  revised.forget(alice.id, { scope: 'alice' });
  await saveBank(path, revised);
  const forgotten = await loadBank(path);
  assert.deepEqual(forgotten.list('alice'), []);
  assert.equal(forgotten.list('bob').length, 1);
  assert.doesNotMatch(await readFile(path, 'utf8'), /小猫模式|下次先问我/);
  assert.deepEqual(await readdir(dir), ['memory.json']);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('damaged or schema-invalid files fail loudly and remain unchanged', async t => {
  const dir = await workspace(t), path = join(dir, 'memory.json');
  for (const content of ['{truncated', '', 'null', '{"schemaVersion":2,"memories":[]}', '{"schemaVersion":1,"memories":[{"text":"missing evidence"}]}', '{"schemaVersion":1,"memories":[],"__proto__":{}}']) {
    await writeFile(path, content);
    await assert.rejects(loadBank(path), /Cannot load memory file/);
    assert.equal(await readFile(path, 'utf8'), content);
  }
});

test('failed atomic rename does not destroy an existing target and removes temporary files', async t => {
  const dir = await workspace(t);
  // A directory cannot be replaced by the temporary regular file.
  await assert.rejects(saveBank(dir, new MemoryBank()));
  assert.equal((await stat(dir)).isDirectory(), true);
  const siblingNames = await readdir(join(dir, '..'));
  const prefix = `.${dir.split('/').at(-1)}.`;
  assert.ok(!siblingNames.some(name => name.startsWith(prefix) && name.endsWith('.tmp')));
});

test('read errors other than a missing file are not mistaken for an empty bank', async t => {
  const dir = await workspace(t);
  await assert.rejects(loadBank(dir));
  await assert.rejects(saveBank(join(dir, 'bad.json'), {}), /MemoryBank/);
});
