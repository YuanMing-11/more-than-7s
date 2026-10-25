/**
 * 不止七秒 (more-than-7s) for DeepSeek Harness (DSH): one shared memory bank, injected into every
 * session's system prompt and written only through tools that cite the user's own words.
 *
 * Plain ESM with no imports from the host: the DSH services used here are reached
 * through `ctx`, tools are raw JSON-Schema definitions, and `Config` implements the
 * Standard Schema interface by hand.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { MemoryBank, MEMORY_KINDS, localDate } from './memory.mjs';
import { loadBank, saveBank } from './storage.mjs';

export const name = 'more-than-7s';
export const inject = ['agents', 'tools'];

// v1 keeps one bank per DSH installation: dsh-qqbot does not tell other plugins which
// QQ user a session belongs to, so per-person isolation is not possible here yet.
export const SCOPE = 'shared';
export const SECTION_NAME = 'more-than-7s:memory';
// After the deployment persona (0), before plan policy (500).
const SECTION_ORDER = 110;
const RECENT_USER_MESSAGES = 6;
const LIST_LIMIT = 100;
// Warm, user-facing labels; the portrait file and tool replies use them.
const KIND_LABELS = { profile: '关于你', preference: '相处习惯', impression: '我的感觉', episode: '我们的故事', promise: '说好的事', boundary: '你不喜欢的' };
const PORTRAIT_ORDER = ['profile', 'preference', 'boundary', 'impression', 'promise', 'episode'];
// Who the user is, how they like to be treated, what they dislike and how the fish
// reads them ride along every turn.
const PINNED_BY_DEFAULT = new Set(['profile', 'preference', 'boundary', 'impression']);

const DEFAULTS = Object.freeze({ enabled: true, dataDir: '', maxChars: 2000, recentDays: 14, requireQuote: true });

export function resolveOptions(input) {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new TypeError('more-than-7s config must be an object');
  const unknown = Object.keys(input).filter(key => !Object.hasOwn(DEFAULTS, key));
  if (unknown.length) throw new TypeError(`Unknown more-than-7s config field: ${unknown.join(', ')}`);
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== null) config[key] = value;
  if (typeof config.enabled !== 'boolean') throw new TypeError('enabled must be true or false');
  if (typeof config.dataDir !== 'string') throw new TypeError('dataDir must be a string');
  if (!Number.isInteger(config.maxChars) || config.maxChars < 200 || config.maxChars > 20000) throw new TypeError('maxChars must be an integer from 200 to 20000');
  if (!Number.isInteger(config.recentDays) || config.recentDays < 0 || config.recentDays > 90) throw new TypeError('recentDays must be an integer from 0 to 90');
  if (typeof config.requireQuote !== 'boolean') throw new TypeError('requireQuote must be true or false');
  return config;
}

/** Cordis only calls `Config['~standard'].validate`, so no schemastery dependency is needed. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'more-than-7s',
    validate(value) {
      try { return { value: resolveOptions(value) }; } catch (error) { return { issues: [{ message: error.message }] }; }
    },
  },
};

export function dataDirectory(dataDir, env = process.env) {
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  return dataDir.trim() ? resolve(home, dataDir.trim()) : join(home, 'more-than-7s');
}

const textOf = blocks => (Array.isArray(blocks) ? blocks : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim();
// Quotes are compared without punctuation, symbols, spacing or letter case.
const compact = value => value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{S}\s]/gu, '');
const required = (args, field) => {
  const value = args?.[field];
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value.trim();
};

// The shortest prefix (at least eight characters) that tells ids apart.
function labelLength(items) {
  let length = 8;
  while (length < 128 && new Set(items.map(m => m.id.slice(0, length))).size < items.length) length++;
  return length;
}

// Accepts a full id or a unique prefix of at least four characters, with or without "#".
function findMemory(items, ref) {
  ref = ref.replace(/^#/u, '');
  const exact = items.find(m => m.id === ref);
  if (exact) return { memory: exact };
  const matches = ref.length >= 4 ? items.filter(m => m.id.startsWith(ref)) : [];
  return matches.length === 1 ? { memory: matches[0] } : { ambiguous: matches.length > 1 };
}

const GUIDE = `## 不止七秒 · 你们之间的事
下面是你和用户之间留下的事：TA 告诉过你的自己，TA 习惯怎样被陪伴、不喜欢什么，你对 TA 的感觉，你们说好了什么、一起经历过什么。最近两周发生的事也在里面。
像一个记性好、心思细、又有分寸的老朋友那样陪 TA：
- 留意话里没说出口的情绪和需要，可以温和地说出你的感觉，比如“听起来你有点累，是不是最近事情太多了？”。猜错了就大方认错，以 TA 的说法为准。
- 把现在的话和你们之间的事连起来，比如 TA 上次面试前也这样紧张过。
- 自然地带进对话，不要背诵，也不要说“根据记忆”“我的记录显示”这类话。
- 用 TA 喜欢的称呼和方式回应；TA 紧张或难过时，先按 TA 说过的方式陪着。
- TA 不喜欢的事，安静地避开，不用每次声明。
- 最近的事和说好的事，合适的时候可以轻轻问起，比如上次说的面试后来怎么样了。
- TA 问“你眼中的我是什么样的”时，可以讲 TA 告诉过你的事，也可以讲你的感觉，但要让 TA 知道哪些是你的感觉。不做医学或心理诊断（比如“抑郁症”“焦虑症”），也不用一个词把 TA 定性。
- 不要用这些事让 TA 内疚、催 TA 回来，也不要说自己一直在想 TA。
- 与 TA 现在的说法冲突时，以现在为准。
关于记下和忘掉：
- TA 明确让你记住，或说起关于自己的事、希望以后怎样相处、和你说好了什么、哪些事不想要时，调用 fish_remember，source 逐字摘录 TA 这次说的原话。
- 你对 TA 有了新的感觉，比如觉得 TA 对自己要求很高，可以记成 impression：用温和、具体的说法写你的感觉，source 摘录让你这样觉得的那句 TA 的话。TA 说不是这样，就改掉或忘掉。
- TA 改口时调用 fish_revise，想让你忘掉时调用 fish_forget；需要编号就先调用 fish_list。做完简单告诉 TA 一声就好。
- 你的感觉只能记成 impression，不能写成 TA 说过的话；别人的隐私不要记。`;

// The portrait file, in the user's own words, shown the way the model reads it.
function renderPortrait(bank) {
  const items = bank.scopes().flatMap(scope => bank.list(scope));
  const length = labelLength(items);
  const lines = ['# 我眼中的你', '', '> 这些是你告诉过我的事，还有我对你的感觉。“我的感觉”是我的猜测，说得不对就告诉我。', '> 想改哪一条，或者想让我忘掉，直接跟我说就好。（这个文件由「不止七秒」自动生成，直接修改不会生效。）', ''];
  for (const kind of PORTRAIT_ORDER) {
    const group = items.filter(m => m.kind === kind).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!group.length) continue;
    lines.push(`## ${KIND_LABELS[kind]}`, '');
    for (const m of group) {
      lines.push(`- **${m.text}** · ${localDate(m.updatedAt)} · #${m.id.slice(0, length)}`);
      lines.push(`  > ${m.kind === 'impression' ? '让我这样觉得的话' : '你说过'}：${m.source.replace(/\s*\n\s*/g, ' ')}`);
    }
    lines.push('');
  }
  if (!items.length) lines.push('还没有记下什么。等你愿意的时候，跟我说说你自己吧。');
  return lines.join('\n') + '\n';
}

async function writeAtomic(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(contents, 'utf8');
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'message'],
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
    id: { type: 'string' },
    memories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'text', 'pinned', 'date'],
        properties: { id: { type: 'string' }, kind: { type: 'string' }, text: { type: 'string' }, pinned: { type: 'boolean' }, date: { type: 'string' } },
      },
    },
  },
};
const OUTPUT = { schema: RESULT_SCHEMA, render: (_args, value) => [{ type: 'text', text: value.message }] };
const SOURCE = { type: 'string', description: '用户本人在这次对话里说的原话，逐字摘录，不要改写、概括或代写。记你的感觉时，摘录让你有这个感觉的那句话。' };
const ID = { type: 'string', description: '记忆编号：fish_list 或记忆段里显示的 # 后几位，也可以是完整 id。' };

export function apply(ctx, rawConfig) {
  const config = resolveOptions(rawConfig);
  if (!config.enabled) return;
  const dir = dataDirectory(config.dataDir);
  const file = join(dir, 'memories.json');
  const portrait = join(dir, '我眼中的你.md');
  const log = message => ctx.logger?.info?.(`[more-than-7s] ${message}`);
  const warn = message => ctx.logger?.warn?.(`[more-than-7s] ${message}`);

  let bank = null;
  let failure = null;
  // A damaged file is left untouched: memory stays read-only empty until it is fixed.
  const ready = loadBank(file).then(loaded => { bank = loaded; log(`记忆档案：${file}`); }, error => { failure = error; warn(`读不了记忆档案，本次不注入也不写入：${error.message}`); });

  let chain = Promise.resolve();
  function mutate(change) {
    const run = chain.then(async () => {
      await ready;
      if (!bank) throw new Error(`记忆档案读不了（${failure?.message}），这次没有写入。请检查 ${file}`);
      const staged = new MemoryBank({ memories: bank.scopes().flatMap(scope => bank.list(scope)) });
      const value = change(staged);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await saveBank(file, staged);
      bank = staged;
      await writeAtomic(portrait, renderPortrait(staged)).catch(error => warn(`画像文件没有更新：${error.message}`));
      return value;
    });
    chain = run.catch(() => {});
    return run;
  }

  // Only words a person typed count as evidence; injected and assistant messages do not.
  const recent = new Map();
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') return;
      const id = session?.id;
      const text = textOf(event.data.content);
      if (typeof id !== 'string' || !text) return;
      const list = [...(recent.get(id) || []), text].slice(-RECENT_USER_MESSAGES);
      recent.delete(id);
      recent.set(id, list);
      if (recent.size > 500) recent.delete(recent.keys().next().value);
    } catch (error) { warn(`记录用户消息失败：${error.message}`); }
  });
  const quoted = (sessionId, source) => {
    const needle = compact(source);
    return needle.length >= 2 && (recent.get(sessionId) || []).some(text => compact(text).includes(needle));
  };
  const unquoted = { ok: false, message: '没有改动记忆：source 必须逐字摘自用户在这次对话里亲口说的话。请引用原话再试，不要改写或代写。' };

  function render(sessionId) {
    try {
      if (!bank) return '';
      const query = (recent.get(sessionId) || []).at(-1) || '';
      const memories = bank.context(query, { scope: SCOPE, maxChars: config.maxChars, recentDays: config.recentDays });
      return [GUIDE, `今天是 ${localDate()}。`, memories || '目前没有找到相关记忆。'].join('\n\n');
    } catch (error) {
      warn(`渲染记忆段失败：${error.message}`);
      return '';
    }
  }

  const sections = new Map();
  function install(agent) {
    if (!agent || sections.has(agent.id)) return;
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], scope => {
        scope.systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text: () => render(agent.id) });
      });
      sections.set(agent.id, fiber);
    } catch (error) { warn(`为会话 ${String(agent.id)} 注册记忆段失败：${error.message}`); }
  }
  for (const agent of ctx.agents.list()) install(agent);
  ctx.on('agent/created', ({ agent }) => install(agent));
  ctx.on('agent/disposed', ({ agent }) => {
    sections.get(agent?.id)?.dispose?.();
    sections.delete(agent?.id);
    recent.delete(agent?.id);
  });
  ctx.effect(() => () => {
    for (const fiber of sections.values()) fiber?.dispose?.();
    sections.clear();
  });

  async function locate(ref) {
    await ready;
    if (!bank) throw new Error(`记忆档案读不了（${failure?.message}）。请检查 ${file}`);
    const found = findMemory(bank.list(SCOPE), ref);
    if (found.memory) return found;
    return { result: { ok: false, message: found.ambiguous ? '有多条记忆以这个编号开头，请多写几位。' : '没有这条记忆。可以先调用 fish_list 查看编号。' } };
  }

  const tools = [
    {
      name: 'fish_remember',
      description: '把一件事记下来，之后的对话里会被想起。用户明确让你记住，或说起关于自己的事、相处习惯、和你说好的事、不喜欢的事、值得纪念的共同经历时使用；你对用户有了新的感觉时，记成 impression。source 必须逐字摘自用户这次说的话，否则不会保存。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'source'],
        properties: {
          kind: { type: 'string', enum: [...MEMORY_KINDS], description: 'profile 关于 TA（身份、生活、在意的人和事）/ preference 相处习惯（含称呼）/ boundary TA 不喜欢的 / impression 你对 TA 的感觉（你的推测）/ promise 说好的事 / episode 我们的故事' },
          text: { type: 'string', description: '一句话。记 TA 说过的事时写清是什么，不要掺进推测；记你的感觉（impression）时，用温和、具体的说法。' },
          source: SOURCE,
          key: { type: 'string', description: '可选：同一件事的固定名字，比如 nickname。同 key 再写会覆盖旧说法。' },
          pinned: { type: 'boolean', description: '可选：是否每次对话都带上。关于 TA、相处习惯、不喜欢的事和你的感觉默认每次都带上。' },
        },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const kind = required(args, 'kind'), text = required(args, 'text'), source = required(args, 'source');
        if (!MEMORY_KINDS.includes(kind)) throw new TypeError(`kind must be one of ${MEMORY_KINDS.join(', ')}`);
        if (args.pinned !== undefined && typeof args.pinned !== 'boolean') throw new TypeError('pinned must be a boolean');
        const key = args.key === undefined ? undefined : required(args, 'key');
        if (config.requireQuote && !quoted(exec?.agent?.id, source)) return unquoted;
        const memory = await mutate(staged => staged.remember({ scope: SCOPE, kind, text, source, key, pinned: args.pinned ?? PINNED_BY_DEFAULT.has(kind) }));
        return { ok: true, id: memory.id, message: `记下了（#${memory.id.slice(0, 8)}，${KIND_LABELS[kind]}）：${memory.text}` };
      },
    },
    {
      name: 'fish_revise',
      description: '用户改口时，按用户现在的说法修改一条记忆。source 是用户这次改口的原话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text', 'source'],
        properties: { id: ID, text: { type: 'string', description: '修改后的一句话。' }, source: SOURCE },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const ref = required(args, 'id'), text = required(args, 'text'), source = required(args, 'source');
        if (config.requireQuote && !quoted(exec?.agent?.id, source)) return unquoted;
        const { memory, result } = await locate(ref);
        if (result) return result;
        const revised = await mutate(staged => staged.revise(memory.id, text, { scope: SCOPE, source }));
        return { ok: true, id: revised.id, message: `改好了（#${revised.id.slice(0, 8)}）：${revised.text}` };
      },
    },
    {
      name: 'fish_forget',
      description: '用户要求忘掉某件事时，删除对应的记忆。删除后不会再被想起。source 是用户要求忘记的原话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'source'],
        properties: { id: ID, source: SOURCE },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const ref = required(args, 'id'), source = required(args, 'source');
        if (config.requireQuote && !quoted(exec?.agent?.id, source)) return unquoted;
        const { memory, result } = await locate(ref);
        if (result) return result;
        await mutate(staged => staged.forget(memory.id, { scope: SCOPE }));
        return { ok: true, id: memory.id, message: `已经忘掉了：${memory.text}` };
      },
    },
    {
      name: 'fish_list',
      description: '查看已经保存的记忆和编号，用于改口或忘记前确认是哪一条。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: OUTPUT,
      async execute() {
        await ready;
        if (!bank) throw new Error(`记忆档案读不了（${failure?.message}）。请检查 ${file}`);
        const items = bank.list(SCOPE).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const length = labelLength(items);
        const shown = items.slice(0, LIST_LIMIT).map(m => ({ id: m.id.slice(0, length), kind: m.kind, text: m.text, pinned: m.pinned, date: localDate(m.updatedAt) }));
        const lines = shown.map(m => `#${m.id} [${KIND_LABELS[m.kind]}${m.pinned ? '·置顶' : ''}] ${m.text}（${m.date}）`);
        const more = items.length > shown.length ? `\n……另有 ${items.length - shown.length} 条较早的记忆未列出。` : '';
        return { ok: true, memories: shown, message: items.length ? `共 ${items.length} 条记忆：\n${lines.join('\n')}${more}` : '还没有保存记忆。' };
      },
    },
  ];
  // Registration is an effect of this plugin: unloading it unregisters the tools.
  for (const tool of tools) ctx.tools.register(tool);
}
