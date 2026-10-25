// Walks through the plugin's real code path inside a stand-in host. The "fish" tool
// calls are scripted: no DSH, no model, no network.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../src/plugin.mjs';
import { createHost } from './fake-host.mjs';

const dir = await mkdtemp(join(tmpdir(), 'more-than-7s-demo-'));
const config = plugin.Config['~standard'].validate({ dataDir: dir }).value;
const start = async () => {
  const host = createHost();
  plugin.apply(host.ctx, config);
  await host.waitForLog(/记忆档案/);
  return host;
};
const indent = text => text.replace(/^/gm, '  │ ');
const call = async (host, agent, name, args) => {
  console.log(`鱼 → ${name} ${JSON.stringify(args)}`);
  console.log(`插件：${(await host.call(agent, name, args)).text}\n`);
};

try {
  console.log('🐟 不止七秒 · DSH 插件流程演示');
  console.log('模拟宿主：按 DSH 官方接口形状写的最小替身，不是真实 DSH，也不调用模型。下面“鱼”的工具调用由脚本写好。\n');

  let host = await start();
  const first = host.createAgent('session-1');
  console.log('【第一次会话】');
  const story = '我紧张时不想听大道理，陪我待会儿，我们叫它小猫模式。';
  console.log(`你：${story}`);
  host.say(first, story);
  await call(host, first, 'fish_remember', { kind: 'preference', key: 'comfort-style', text: '紧张时先陪着，不讲大道理；这种陪伴叫“小猫模式”', source: story });
  const about = '我是大三学生，学计算机的。';
  console.log(`你：${about}`);
  host.say(first, about);
  await call(host, first, 'fish_remember', { kind: 'profile', key: 'school', text: '大三，学计算机', source: about });
  console.log('（如果模型想替用户编一句话：）');
  await call(host, first, 'fish_remember', { kind: 'promise', text: '每天早上叫用户起床', source: '你每天早上都叫我起床吧' });

  console.log('—— 卸载插件，从磁盘重新加载：模拟关掉再打开 DSH ——\n');
  host.unload();
  host = await start();
  const second = host.createAgent('session-2');
  console.log('【第二次会话】');
  console.log('你：明天面试，我又有点慌。');
  host.say(second, '明天面试，我又有点慌。');
  console.log('这一轮注入给模型的记忆段：');
  console.log(indent(host.prompt(second)) + '\n');

  const card = (await host.call(second, 'fish_list')).value.memories.find(m => m.text.includes('小猫模式'));
  console.log('你：小猫模式那条，忘了吧。');
  host.say(second, '小猫模式那条，忘了吧。');
  await call(host, second, 'fish_forget', { id: `#${card.id}`, source: '小猫模式那条，忘了吧' });
  console.log('再次组装时的记忆数据：');
  console.log(indent(host.prompt(second).split('\n\n').at(-1)) + '\n');
  console.log('磁盘上的画像（我眼中的你.md）：');
  console.log(indent((await readFile(join(dir, '我眼中的你.md'), 'utf8')).trim()));
} finally {
  await rm(dir, { recursive: true, force: true });
}
