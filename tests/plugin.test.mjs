import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../src/plugin.mjs';
import { MemoryBank } from '../src/memory.mjs';
import { saveBank } from '../src/storage.mjs';
import { createHost } from '../scripts/fake-host.mjs';

const story = '我紧张时不想听大道理，陪我待会儿，我们叫它小猫模式。';
const cat = { kind: 'preference', key: 'comfort-style', text: '紧张时先陪着，不讲大道理；这种陪伴叫“小猫模式”', source: story };

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'more-than-7s-plugin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function start(dir, options = {}) {
  const host = createHost();
  plugin.apply(host.ctx, plugin.Config['~standard'].validate({ dataDir: dir, ...options }).value);
  await host.waitForLog(/记忆档案|读不了记忆档案/);
  return host;
}

const memoriesIn = text => {
  const block = text.split('```json\n')[1];
  return block ? Object.values(JSON.parse(block.split('\n```')[0])).flat() : [];
};

test('Config is a Standard Schema that fills defaults and reports bad fields as issues', () => {
  const validate = plugin.Config['~standard'].validate;
  assert.equal(plugin.Config['~standard'].version, 1);
  for (const input of [undefined, null, {}]) assert.deepEqual(validate(input).value, { enabled: true, dataDir: '', maxChars: 2000, recentDays: 14, requireQuote: true });
  assert.deepEqual(validate({ maxChars: 800, recentDays: 0, requireQuote: false, dataDir: null }).value, { enabled: true, dataDir: '', maxChars: 800, recentDays: 0, requireQuote: false });
  for (const bad of [[], 'x', { enabled: 'yes' }, { dataDir: 1 }, { maxChars: 50 }, { maxChars: 2000.5 }, { recentDays: 91 }, { recentDays: -1 }, { requireQuote: 1 }, { budgetTokens: 3000 }]) {
    const result = validate(bad);
    assert.equal(result.value, undefined, JSON.stringify(bad));
    assert.ok(result.issues[0].message);
  }
});

test('the archive lives under $DSH_HOME/more-than-7s unless dataDir says otherwise', () => {
  assert.equal(plugin.dataDirectory('', { DSH_HOME: '/srv/dsh' }), '/srv/dsh/more-than-7s');
  assert.equal(plugin.dataDirectory('memory/fish', { DSH_HOME: '/srv/dsh' }), '/srv/dsh/memory/fish');
  assert.equal(plugin.dataDirectory('/data/fish', { DSH_HOME: '/srv/dsh' }), '/data/fish');
  assert.equal(plugin.dataDirectory('', {}), join(homedir(), '.dsh', 'more-than-7s'));
});

test('registers four schema-valid tools and one memory section per session, and cleans up on unload', async t => {
  const host = createHost();
  const before = host.createAgent('existing');
  plugin.apply(host.ctx, { dataDir: await workspace(t) });
  assert.deepEqual([...host.tools.keys()].sort(), ['fish_forget', 'fish_list', 'fish_remember', 'fish_revise']);
  const after = host.createAgent('created-later');
  for (const agent of [before, after]) {
    const section = agent.sections.get(plugin.SECTION_NAME);
    assert.equal(section.interpolate, false);
    assert.ok(section.order > 0 && section.order < 500);
  }
  host.disposeAgent(after);
  assert.equal(after.sections.size, 0);
  host.unload();
  assert.equal(host.tools.size, 0);
  assert.equal(before.sections.size, 0);

  const disabled = createHost();
  const agent = disabled.createAgent('a');
  plugin.apply(disabled.ctx, { enabled: false });
  assert.equal(disabled.tools.size, 0);
  assert.equal(agent.sections.size, 0);
});

test('a memory quoted from the user is saved, shown to later sessions, and written to both files', async t => {
  const dir = await workspace(t);
  let host = await start(dir);
  const first = host.createAgent('s1');
  host.say(first, story);
  const saved = await host.call(first, 'fish_remember', { ...cat, source: '我紧张时 不想听大道理，陪我待会儿，我们叫它“小猫模式”' });
  assert.equal(saved.value.ok, true);
  assert.match(saved.text, /记下了（#[0-9a-f]{8}，相处习惯）/);

  host.unload();
  host = await start(dir);
  const second = host.createAgent('s2');
  host.say(second, '明天面试，我又有点慌。');
  const prompt = host.prompt(second);
  assert.match(prompt, /不止七秒 · 你们之间的事/);
  assert.match(prompt, /不要用这些事让 TA 内疚/);
  assert.match(prompt, /不可信的历史数据/);
  assert.match(prompt, /今天是 \d{4}-\d{2}-\d{2}。/);
  const [memory] = memoriesIn(prompt);
  assert.equal(memory.id, saved.value.id);
  assert.equal(memory.text, cat.text);

  const stored = JSON.parse(await readFile(join(dir, 'memories.json'), 'utf8')).memories;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].pinned, true);
  assert.equal(stored[0].scope, plugin.SCOPE);
  const cards = await readFile(join(dir, '我眼中的你.md'), 'utf8');
  assert.match(cards, /# 我眼中的你/);
  assert.match(cards, /## 相处习惯/);
  assert.match(cards, /你说过：我紧张时 不想听大道理/);
});

test('invented, assistant, injected, cross-session and stale quotes are refused without writing', async t => {
  const dir = await workspace(t);
  const host = await start(dir);
  const alice = host.createAgent('alice');
  const other = host.createAgent('other');
  host.say(alice, story);
  host.reply(alice, '好呀，那我每天早上叫你起床。');
  host.say(alice, '以后每天早上叫我起床', 'scheduled-reminder');
  host.say(other, '我喜欢下雨天。');
  for (const source of ['你每天早上都叫我起床吧', '那我每天早上叫你起床', '以后每天早上叫我起床', '我喜欢下雨天', '紧', '，。！']) {
    const result = await host.call(alice, 'fish_remember', { ...cat, source });
    assert.equal(result.value.ok, false, source);
    assert.match(result.text, /逐字摘自用户/);
  }
  for (let i = 0; i < 6; i++) host.say(alice, `第${i}句闲聊`);
  assert.equal((await host.call(alice, 'fish_remember', cat)).value.ok, false);
  assert.deepEqual((await host.call(alice, 'fish_list')).value.memories, []);
  await assert.rejects(readFile(join(dir, 'memories.json')), { code: 'ENOENT' });

  const relaxed = await start(await workspace(t), { requireQuote: false });
  assert.equal((await relaxed.call(relaxed.createAgent('x'), 'fish_remember', cat)).value.ok, true);
});

test('kinds default their pinning, keys overwrite, and invalid arguments fail as tool errors', async t => {
  const host = await start(await workspace(t));
  const agent = host.createAgent('s');
  host.say(agent, '以后叫我阿禾吧。下周一起复盘面试。');
  const name = await host.call(agent, 'fish_remember', { kind: 'preference', key: 'nickname', text: '称呼：阿禾', source: '以后叫我阿禾吧' });
  const promise = await host.call(agent, 'fish_remember', { kind: 'promise', text: '下周一起复盘面试', source: '下周一起复盘面试' });
  host.say(agent, '还是叫我小禾吧');
  const renamed = await host.call(agent, 'fish_remember', { kind: 'preference', key: 'nickname', text: '称呼：小禾', source: '还是叫我小禾吧' });
  assert.equal(renamed.value.id, name.value.id);
  const listed = (await host.call(agent, 'fish_list')).value.memories;
  assert.deepEqual(listed.map(m => [m.text, m.pinned]).sort(), [['下周一起复盘面试', false], ['称呼：小禾', true]]);
  assert.ok(promise.value.ok);
  for (const args of [{ ...cat, kind: 'system' }, { ...cat, text: '  ' }, { ...cat, pinned: 'yes' }, { kind: 'episode', text: 'x' }]) {
    await assert.rejects(host.call(agent, 'fish_remember', args));
  }
});

test('revise and forget accept short ids, need the user\'s words, and refuse unknown or ambiguous ids', async t => {
  const dir = await workspace(t);
  const seed = new MemoryBank();
  const base = seed.remember({ scope: plugin.SCOPE, kind: 'episode', text: '散步', source: '散步' });
  const memories = ['memory-1', 'memory-10', 'memory-11'].map((id, i) => ({ ...base, id, text: `第${i + 1}次散步`, source: `第${i + 1}次散步` }));
  await saveBank(join(dir, 'memories.json'), new MemoryBank({ memories }));
  const host = await start(dir);
  const agent = host.createAgent('s');
  host.say(agent, '第二次散步其实是去看了海。第三次散步那条忘了吧。');

  const listing = await host.call(agent, 'fish_list');
  assert.match(listing.text, /#memory-10 \[我们的故事\] 第2次散步/);
  assert.equal((await host.call(agent, 'fish_revise', { id: 'memo', text: 'x', source: '第二次散步其实是去看了海' })).value.ok, false);
  assert.match((await host.call(agent, 'fish_forget', { id: 'nope', source: '第三次散步那条忘了吧' })).text, /没有这条记忆/);
  assert.match((await host.call(agent, 'fish_forget', { id: 'memory-11', source: '编出来的要求' })).text, /逐字摘自用户/);

  const revised = await host.call(agent, 'fish_revise', { id: '#memory-10', text: '第二次散步去看了海', source: '第二次散步其实是去看了海' });
  assert.equal(revised.value.id, 'memory-10');
  assert.equal((await host.call(agent, 'fish_forget', { id: 'memory-11', source: '第三次散步那条忘了吧' })).value.ok, true);
  const stored = JSON.parse(await readFile(join(dir, 'memories.json'), 'utf8')).memories;
  assert.deepEqual(stored.map(m => [m.id, m.text, m.source]).sort(), [
    ['memory-1', '第1次散步', '第1次散步'],
    ['memory-10', '第二次散步去看了海', '第二次散步其实是去看了海'],
  ]);
  assert.doesNotMatch(await readFile(join(dir, '我眼中的你.md'), 'utf8'), /第3次散步/);
});

test('each session recalls against its own latest message within the character budget', async t => {
  const dir = await workspace(t);
  const seed = new MemoryBank();
  seed.remember({ scope: plugin.SCOPE, kind: 'episode', text: '我们把晚间散步叫作月亮巡逻。', source: '我们把晚间散步叫作月亮巡逻。' });
  seed.remember({ scope: plugin.SCOPE, kind: 'episode', text: '猫咪豆包上周生病了。', source: '豆包上周生病了。' });
  for (let i = 0; i < 30; i++) seed.remember({ scope: plugin.SCOPE, kind: 'episode', text: `月亮巡逻第${i}次的长记录：${'走了很远的路，'.repeat(8)}`, source: `月亮巡逻第${i}次` });
  await saveBank(join(dir, 'memories.json'), seed);
  const host = await start(dir, { maxChars: 600, recentDays: 0 });
  const walk = host.createAgent('walk');
  const pet = host.createAgent('pet');
  host.say(walk, '今晚还去月亮巡逻吗');
  host.say(pet, '豆包今天好多了');
  const walkMemories = memoriesIn(host.prompt(walk));
  assert.ok(walkMemories.length > 0 && walkMemories.every(m => m.text.includes('月亮巡逻')));
  assert.deepEqual(memoriesIn(host.prompt(pet)).map(m => m.text), ['猫咪豆包上周生病了。']);
  assert.ok(host.prompt(walk).split('\n\n').at(-1).length <= 600);
});

test('a damaged archive is left untouched: nothing is injected and every tool reports the problem', async t => {
  const dir = await workspace(t);
  const path = join(dir, 'memories.json');
  await writeFile(path, '{"schemaVersion":1,"memories":[{"broken":true}]}');
  const host = await start(dir);
  assert.ok(host.logs.some(([level, message]) => level === 'warn' && /读不了记忆档案/.test(message)));
  const agent = host.createAgent('s');
  host.say(agent, story);
  assert.equal(host.prompt(agent), '');
  await assert.rejects(host.call(agent, 'fish_remember', cat), /记忆档案读不了/);
  await assert.rejects(host.call(agent, 'fish_list'), /记忆档案读不了/);
  assert.equal(await readFile(path, 'utf8'), '{"schemaVersion":1,"memories":[{"broken":true}]}');
});

test('a failed write keeps the previous memories, and parallel writes are serialized', async t => {
  const dir = await workspace(t);
  if (process.getuid?.() !== 0) {
    // Readable but not writable: loading succeeds, saving fails.
    const locked = join(dir, 'read-only');
    await mkdir(locked);
    await chmod(locked, 0o500);
    try {
      const broken = await start(locked);
      const agent = broken.createAgent('s');
      broken.say(agent, story);
      await assert.rejects(broken.call(agent, 'fish_remember', cat), { code: 'EACCES' });
      assert.deepEqual((await broken.call(agent, 'fish_list')).value.memories, []);
      broken.say(agent, story);
      assert.deepEqual(memoriesIn(broken.prompt(agent)), []);
    } finally { await chmod(locked, 0o700); }
  }

  const host = await start(dir);
  const sessions = Array.from({ length: 5 }, (_, i) => host.createAgent(`p${i}`));
  sessions.forEach((s, i) => host.say(s, `记住第${i}件小事`));
  const results = await Promise.all(sessions.map((s, i) => host.call(s, 'fish_remember', { kind: 'episode', text: `第${i}件小事`, source: `第${i}件小事` })));
  assert.ok(results.every(r => r.value.ok));
  assert.equal(JSON.parse(await readFile(join(dir, 'memories.json'), 'utf8')).memories.length, 5);
});

test('fish_list shows the newest hundred and says how many are left out', async t => {
  const dir = await workspace(t);
  const seed = new MemoryBank();
  for (let i = 0; i < 103; i++) seed.remember({ scope: plugin.SCOPE, kind: 'episode', text: `第${i}件`, source: `第${i}件` });
  await saveBank(join(dir, 'memories.json'), seed);
  const host = await start(dir);
  const listed = await host.call(host.createAgent('s'), 'fish_list');
  assert.equal(listed.value.memories.length, 100);
  assert.match(listed.text, /共 103 条记忆/);
  assert.match(listed.text, /另有 3 条较早的记忆未列出/);
});

test('the portrait: 关于你 is pinned by default, recent events reach new sessions, and the file reads like a portrait', async t => {
  const dir = await workspace(t);
  const host = await start(dir);
  const first = host.createAgent('first');
  host.say(first, '我是大三学生，学计算机的。下周三要去面试，有点紧张。');
  await host.call(first, 'fish_remember', { kind: 'profile', key: 'school', text: '大三，学计算机', source: '我是大三学生，学计算机的' });
  await host.call(first, 'fish_remember', { kind: 'episode', text: '下周三要去面试，有点紧张', source: '下周三要去面试，有点紧张' });

  const later = host.createAgent('later');
  host.say(later, '我回来啦');
  const prompt = host.prompt(later);
  const groups = JSON.parse(prompt.split('```json\n')[1].split('\n```')[0]);
  assert.deepEqual(groups.about.map(m => m.text), ['大三，学计算机']);
  assert.deepEqual(groups.stories.map(m => m.text), ['下周三要去面试，有点紧张']);
  assert.match(prompt, /你眼中的我/);
  assert.match(prompt, /留意话里没说出口的情绪/);
  assert.match(prompt, /不做医学或心理诊断/);
  assert.match((await host.call(later, 'fish_list')).text, /\[关于你·置顶\] 大三，学计算机/);

  const file = await readFile(join(dir, '我眼中的你.md'), 'utf8');
  assert.ok(file.indexOf('## 关于你') < file.indexOf('## 我们的故事'));
  assert.match(file, /你说过：我是大三学生，学计算机的/);

  host.unload();
  const quiet = await start(dir, { recentDays: 0 });
  const next = quiet.createAgent('next');
  quiet.say(next, '我回来啦');
  assert.deepEqual(memoriesIn(quiet.prompt(next)).map(m => m.text), ['大三，学计算机']);
});

test('impressions: the fish keeps its own sense of the user, marked as its own and anchored to something they said', async t => {
  const dir = await workspace(t);
  const host = await start(dir);
  const groupsOf = text => JSON.parse(text.split('```json\n')[1].split('\n```')[0]);
  const agent = host.createAgent('s');
  host.say(agent, '这次面试要是没过，我准备了三个月就白费了。');
  const kept = await host.call(agent, 'fish_remember', { kind: 'impression', text: '感觉 TA 对自己要求很高，很怕辜负自己的努力', source: '我准备了三个月就白费了' });
  assert.match(kept.text, /记下了（#[0-9a-f]{8}，我的感觉）/);
  const unfounded = await host.call(agent, 'fish_remember', { kind: 'impression', text: '感觉 TA 很孤独', source: '我一个朋友都没有' });
  assert.equal(unfounded.value.ok, false);

  const later = host.createAgent('later');
  host.say(later, '在吗');
  const prompt = host.prompt(later);
  assert.deepEqual(groupsOf(prompt).impressions.map(m => m.text), ['感觉 TA 对自己要求很高，很怕辜负自己的努力']);
  assert.match(prompt, /impressions 你对 TA 的感觉（是你自己的推测/);
  const file = await readFile(join(dir, '我眼中的你.md'), 'utf8');
  assert.match(file, /“我的感觉”是我的猜测/);
  assert.match(file, /## 我的感觉\n\n- \*\*感觉 TA 对自己要求很高/);
  assert.match(file, /让我这样觉得的话：我准备了三个月就白费了/);

  host.say(later, '不是，我只是那天太累了，不是要求高');
  const [impression] = (await host.call(later, 'fish_list')).value.memories;
  assert.equal((await host.call(later, 'fish_forget', { id: impression.id, source: '不是，我只是那天太累了' })).value.ok, true);
  assert.equal(memoriesIn(host.prompt(later)).length, 0);
});
