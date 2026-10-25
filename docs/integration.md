# 装进 DSH

「不止七秒」是 DeepSeek Harness（DSH）插件：纯 JavaScript ESM，不需要构建，也不 import 任何 DSH 包。下面的接口细节来自 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码与官方开发文档（2026-10-25 查阅，DSH 0.2.1-rc.3）。**插件只在按这些接口编写的模拟宿主里测试过，还没有在真实 DSH 中加载过。**

## 安装与卸载

```bash
dsh plugin --profile desktop add github:YuanMing-11/more-than-7s
dsh plugin --profile desktop remove more-than-7s
```

官方支持从本地目录、GitHub、npm 或 tarball 安装（[打包与安装](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）。`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，安装后这一行会被插入 profile。卸载不会删除记忆档案。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后不注册工具、不注入记忆 |
| `dataDir` | `''` | 档案目录。空 = `$DSH_HOME/more-than-7s`（未设置时为 `~/.dsh/more-than-7s`）；相对路径按 `$DSH_HOME` 解析 |
| `maxChars` | `2000` | 每轮注入的记忆数据字符上限，200–20000；不是 token |
| `recentDays` | `14` | 这么多天内的故事和说好的事每轮都带上（最多 5 条），0–90；0 = 关闭 |
| `requireQuote` | `true` | 写入、改口、忘记都要核对原话 |

`Config` 是手写的 Standard Schema（Cordis 加载时只调用 `Config['~standard'].validate`），未知键和错误类型会让插件加载失败并给出原因。没有用 schemastery，所以 DSH 设置页不会为它生成表单，请直接改 `cordis.patch.yml`。

## 它在 DSH 里做了什么

```text
session/event（user/message，source.kind = user）→ 记下本会话最近 6 句用户原话
agent/created → 给该会话注册 systemPrompt 段 more-than-7s:memory（order 110，interpolate: false）
每次组装提示词 → 置顶卡 + 用该会话最新一句召回的卡 + 最近的故事和约定 → 说明 + 今天日期 + 分组画像（JSON）
模型调用工具 → 核对原话 → 串行写入 memories.json → 更新 我眼中的你.md
agent/disposed / 插件卸载 → 撤掉记忆段
```

插件声明 `inject = ['agents', 'tools']`；记忆段通过 `agent.ctx.inject(['systemPrompt'], …)` 按会话注册，这是 feiyu-memory 采用的做法。order 110 位于部署人设（0）之后、计划策略（500）之前。

## 四个工具

工具是手写 JSON Schema 的原始定义，只用 DSH 工具注册表支持的关键字（type / properties / required / additionalProperties / items / enum）。参数由插件自己校验。返回值统一为 `{ ok, message, id?, memories? }`。

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `fish_remember` | `kind`、`text`、`source`，可选 `key`、`pinned` | `kind` 为 profile（关于你）/ preference（相处习惯）/ boundary（你不喜欢的）/ impression（我的感觉，模型自己的推测）/ promise（说好的事）/ episode（我们的故事）。前四类默认置顶。同 `key` 再写会覆盖旧说法 |
| `fish_revise` | `id`、`text`、`source` | 按用户现在的说法修改 |
| `fish_forget` | `id`、`source` | 从档案删除 |
| `fish_list` | 无 | 最近更新的 100 条，带编号 |

`id` 可以是完整 ID、`#` 加前几位，或任意至少四位的唯一前缀。编号不存在或有歧义时返回 `ok: false`，不改动任何记忆。

## 原话校验

- 只有 `user/message` 且 `source.kind === 'user'` 的消息算证据：模型回复、定时任务或其他插件注入的消息都不算。
- 证据范围是**调用工具的那个会话**最近 6 句用户消息；别的会话里说的话不算。
- 比较时忽略标点、符号、空格和大小写；`source` 至少要有两个有效字符。
- 插件重启后，只有重启之后说的话算证据。
- 校验失败时工具返回 `ok: false` 和原因，模型可以引用原话重试。
- `requireQuote: false` 会关闭校验。

校验能挡住模型编造的原话，但挡不住用户自己说出来的内容。比如用户把别人的隐私说了出来，模型照样可以存下。提示词要求模型不要记录他人隐私，这只是约束，不是保证。

## 档案

```text
$DSH_HOME/more-than-7s/
  memories.json   权威数据：schemaVersion 1，所有记忆在 scope "shared" 下
  我眼中的你.md     自动生成的画像，按六类整理；用户说的事附原话，模型的感觉附来由；直接修改不会生效
```

- 写入先写临时文件（权限 0600）再原子替换；同一进程内的写入串行执行。
- 档案损坏时插件不会覆盖它：记忆段为空，四个工具都报错并给出文件路径。修好或移走文件后重启 DSH。
- 写入失败时内存里的记忆保持原状，不会出现“界面显示记住了、磁盘上没有”。
- 不支持多个 DSH 进程同时写同一个目录。

## QQ

用腾讯官方 [dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) 接 QQ。它为每个私聊用户和每个群各开一个会话，会话 ID 由 `qqbot:<appId>:<c2c|group>:<peerId>` 推导；群消息正文里带有 `[昵称 (发送者ID)]` 标记。它没有把 QQ 用户身份暴露给其他插件，`/new` 之后会话 ID 也会变。

因此 v1 所有会话共用一份记忆。只给自己用的机器人可以放心装；对很多人开放的机器人，大家会读到彼此的记忆，请不要装「不止七秒」。按人隔离需要 dsh-qqbot 提供会话到 QQ 用户的映射，或者「不止七秒」解析群消息前缀；后者比较脆弱，v1 不做。

## 与其他插件共存

- 记忆段名为 `more-than-7s:memory`，工具名都以 `fish_` 开头，不会和 feiyu-memory（`feiyu:memory`、`feiyu_note`）或 dsh-companion（`deployment:persona`、`update_memory`）冲突。
- 但两个记忆插件同时开，模型会同时看到两份记忆，可能重复或互相矛盾。建议只开一个。
-「不止七秒」不提供人设。人设交给 DSH 预设或人设插件。

## 画像

注入给模型的记忆数据是一幅按类分组的画像：

```json
{"about":[…], "habits":[…], "dislikes":[…], "impressions":[…], "promises":[…], "stories":[…]}
```

每条为 `{ id, date, text, source }`。入选顺序：

1. 置顶卡：按“你不喜欢的 → 关于你 → 相处习惯 → 我的感觉 → 说好的事 → 我们的故事”排，同类新的在前。用户说过的事先于模型的感觉保留。
2. 用户最新一句召回的其他卡，按匹配度排。
3. `recentDays` 天内更新、未置顶的故事和说好的事，新的在前，最多 5 条，即使这句话没提到也会带上。

按这个顺序逐条尝试放入 `maxChars`，放不下就跳过。所以预算紧张时，“你不喜欢的”最先保留。

画像里有两种东西：用户说过的事，和模型自己的感觉（`impression`）。主动推测被视为情感细腻的表现，提示词鼓励模型察觉没说出口的情绪、温和地说出感觉、猜错就认错。两者分开存放和标注，模型的感觉同样要引用用户在本会话说过的一句话作为来由，所以不会凭空产生，用户也能逐条纠正或删除。插件不在后台调用模型总结。

提示词要求模型回答“你眼中的我”时讲清哪些是感觉，不做医学或心理诊断，不用一个词把用户定性；这是对模型的约束，不是插件能强制的保证。

## 召回

- 中文按相邻两个字、英文按单词匹配；置顶卡优先；“我们”“什么”“那天”等常用词不单独触发召回。
- 没有向量语义匹配，同义改写找不到。置顶卡太多会挤占预算。`npm run eval` 可以复现这些结论。
- 每张卡带最后更新日期，并告诉模型今天的日期，用于判断新旧说法和“明天”“上周”这类相对时间。日期按运行 DSH 的机器的本地时区计算。
- 注入的记忆会随每轮请求发给 DSH 配置的模型服务。忘记一条记忆，无法撤回已经发出的请求。
