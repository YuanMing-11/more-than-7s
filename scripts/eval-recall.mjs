// Companion-scenario recall check for the lexical retriever. It reports; it never fails.
// "top-4" is what Companion passes to the offline template; "context" is what a model sees.
import { MemoryBank } from '../src/memory.mjs';

const scope = 'eval';
let clock = Date.UTC(2026, 0, 1);
function m(id, kind, text, { source = text, pinned = false, key = null } = {}) {
  const at = new Date(clock += 60_000).toISOString();
  return { id, scope, kind, text, source, key, pinned, createdAt: at, updatedAt: at };
}
const boundaries = [
  m('nick', 'preference', '称呼：阿禾', { pinned: true, key: 'nickname' }),
  m('b1', 'boundary', '别拿我的成绩开玩笑。', { pinned: true }),
  m('b2', 'boundary', '不要叫我宝贝。', { pinned: true }),
  m('b3', 'preference', '先简短回应，想听建议时我会说。', { pinned: true }),
  m('b4', 'boundary', '深夜不要催我睡觉。', { pinned: true }),
];
const longPinned = Array.from({ length: 12 }, (_, i) => m(`p${i}`, 'preference', `第${i + 1}条相处偏好：${'说话慢一点，先听我说完，再给建议。'.repeat(6)}`, { pinned: true }));

export const cases = [
  ['原词复现', '共同经历的叫法', [m('walk', 'episode', '我们把晚间散步叫作月亮巡逻。')], '今晚还去月亮巡逻吗', { want: ['walk'] }],
  ['原词复现', '紧张时的陪伴方式', [m('cat', 'preference', '紧张时先陪我待会儿，我们叫它小猫模式。', { key: 'comfort' })], '明天面试，好紧张', { want: ['cat'] }],
  ['原词复现', '未完成的约定', [m('review', 'promise', '下周一起复盘面试。')], '面试结束了，我们复盘一下吧', { want: ['review'] }],
  ['原词复现', '宠物名字', [m('pet', 'episode', '上周猫咪豆包生病了，去了医院。')], '豆包今天好多了', { want: ['pet'] }],
  ['原词复现', '难过的那天', [m('exam', 'episode', '考研失败那天，我们聊到凌晨。')], '又想起考研那天了', { want: ['exam'] }],
  ['原词复现', '中英混写', [m('song', 'episode', '第一次一起听 Taylor Swift 的歌。')], '放首taylor swift吧', { want: ['song'] }],

  ['同义改写', '面试 → 应聘', [m('cat', 'preference', '面试前想先被陪伴，不要讲道理。', { key: 'comfort' })], '下午要去应聘了', { want: ['cat'] }],
  ['同义改写', '散步 → 出去走走', [m('walk', 'episode', '我们把晚间散步叫作月亮巡逻。')], '晚饭后出去走走吧', { want: ['walk'] }],
  ['同义改写', '红茶 → 下午茶', [m('tea', 'preference', '喜欢喝红茶，不加糖。')], '给我推荐个下午茶', { want: ['tea'] }],
  ['同义改写', '猫咪 → 喵星人', [m('pet', 'episode', '上周猫咪豆包生病了，去了医院。')], '我家喵星人今天不吃饭', { want: ['pet'] }],
  ['同义改写', '紧张 → 心里没底', [m('cat', 'preference', '紧张时先陪我待会儿，我们叫它小猫模式。', { key: 'comfort' })], '明天汇报，心里没底', { want: ['cat'] }],

  ['改口与冲突', '同 key 改口只剩新说法', [m('cat', 'preference', '现在紧张时想直接练习面试。', { key: 'comfort', source: '以后别开小猫模式了，直接陪我练。' })], '面试好紧张', { want: ['cat'] }],
  ['改口与冲突', '无 key 新旧说法都找回（按日期分新旧）', [m('old', 'preference', '每天早上喝一杯咖啡。'), m('new', 'preference', '最近戒咖啡了，改喝茶。')], '来杯咖啡吗', { want: ['old', 'new'] }],
  ['改口与冲突', '否定偏好也要被找回', [m('cilantro', 'preference', '我不吃香菜。')], '推荐一道有香菜的菜', { want: ['cilantro'] }],
  ['改口与冲突', '边界在无关话题中仍在', [...boundaries.slice(1, 3), m('walk', 'episode', '我们把晚间散步叫作月亮巡逻。')], '亲爱的晚安', { want: ['b1', 'b2'], avoid: ['walk'] }],

  ['不该想起', '无关天气问题', [m('walk', 'episode', '我们把晚间散步叫作月亮巡逻。'), m('tea', 'preference', '喜欢喝红茶，不加糖。')], '今天天气怎么样', { avoid: ['walk', 'tea'] }],
  ['不该想起', '只共享“那天”', [m('late', 'episode', '那天我们聊到很晚。')], '那天的会议纪要帮我整理下', { avoid: ['late'] }],
  ['不该想起', '只共享“我们”', [m('movie', 'episode', '我们一起看了一部电影。')], '我们开始工作吧', { avoid: ['movie'] }],
  ['不该想起', '只共享“什么”', [m('gift', 'episode', '生日那天问我想要什么礼物。')], '你在干什么', { avoid: ['gift'] }],
  ['不该想起', '只共享“一个”', [m('dream', 'episode', '跟你讲过一个奇怪的梦。')], '帮我想一个标题', { avoid: ['dream'] }],

  ['置顶挤占', '5 条置顶 + 1 条相关经历', [...boundaries, m('walk', 'episode', '我们把晚间散步叫作月亮巡逻。')], '今晚还去月亮巡逻吗', { want: ['walk'] }],
  ['置顶挤占', '12 条长置顶 + 1 条相关经历', [...longPinned, m('walk', 'episode', '我们把晚间散步叫作月亮巡逻。')], '今晚还去月亮巡逻吗', { want: ['walk'] }],
].map(([group, name, memories, query, expected]) => ({ group, name, memories, query, want: [], avoid: [], ...expected }));

function contextIds(bank, query) {
  const text = bank.context(query, { scope, maxChars: 2000 });
  return text ? Object.values(JSON.parse(text.split('```json\n')[1].split('\n```')[0])).flat().map(r => r.id) : [];
}
const passes = (ids, { want, avoid }) => want.every(id => ids.includes(id)) && avoid.every(id => !ids.includes(id));

export function evaluate() {
  return cases.map(item => {
    const bank = new MemoryBank({ memories: item.memories });
    const top = bank.recall(item.query, { scope, limit: 4 }).map(r => r.id);
    return { ...item, top: passes(top, item), context: passes(contextIds(bank, item.query), item) };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = evaluate();
  const mark = ok => (ok ? '✓' : '✗');
  console.log('| 类别 | 场景 | 查询 | top-4 | context |\n| --- | --- | --- | :-: | :-: |');
  for (const r of results) console.log(`| ${r.group} | ${r.name} | ${r.query} | ${mark(r.top)} | ${mark(r.context)} |`);
  console.log('\n| 类别 | top-4 | context |\n| --- | :-: | :-: |');
  for (const group of [...new Set(results.map(r => r.group)), '合计']) {
    const rows = group === '合计' ? results : results.filter(r => r.group === group);
    console.log(`| ${group} | ${rows.filter(r => r.top).length}/${rows.length} | ${rows.filter(r => r.context).length}/${rows.length} |`);
  }
}
