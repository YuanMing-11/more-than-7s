# 本地验证记录

最近更新：2026-10-25（北京时间），v0.2.0（改为 DSH 插件，加入人物画像和“我的感觉”）。环境：macOS，Node.js v22.23.1。

## 一句话结论

插件逻辑在**模拟宿主**里全部测试通过。模拟宿主按 DeepSeek Harness 官方源码中的接口编写，但它不是 DSH。**「不止七秒」还没有在真实 DSH 中加载过，也没有接过真实 DeepSeek 模型或 QQ。**

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | **32 / 32 通过**：插件 13 项、记忆内核 15 项、文件持久化 4 项 |
| 变异检查 | 在临时副本里分别①去掉原话校验、②把模型回复和注入消息当证据、③召回时不看用户最新一句、④不再带上最近的事、⑤预算紧张时先保“关于你”而不是“你不喜欢的”、⑥“关于你”不再默认置顶、⑦预算紧张时先保模型的感觉而不是用户说过的事。七种情况都有测试失败，说明测试确实守着这些行为 |
| `npm run demo` | 用插件真实代码在模拟宿主里走完：记住 → 编造原话被拒 → 卸载重载 → 新会话注入 → 忘记 → 画像文件清空 |
| `npm pack` + 离线安装 | 包内只有 `src/`、`cordis.patch.yml`、README、LICENSE；`import 'more-than-7s'` 能拿到 `name`、`inject`、`Config`、`apply`；`more-than-7s/memory` 可用 |
| `node --check` | `src/*.mjs`、`scripts/*.mjs` 全部通过 |
| `npm run eval` | 22 个陪伴场景：top-4 为 15/22，context 为 16/22，与上一轮相同（记忆内核未改） |

## 模拟宿主做了什么、没做什么

`scripts/fake-host.mjs` 按 DSH 源码实现了「不止七秒」用到的接口：

- 工具注册：拒绝 DSH 不支持的 JSON Schema 关键字；要求 `output.render`；冻结参数；`exec` 带 `agent`、`signal`；按 `output.schema` 校验返回值。
- 提示词段：按会话 `agent.ctx.inject(['systemPrompt'], …)` 注册；同名重复注册报错；按 order 拼接。
- 事件：`session/event`（`user/message` 带 `source.kind`、`assistant/message`）、`agent/created`、`agent/disposed`。
- 卸载：执行所有 effect 的清理函数，撤销工具和事件监听。

它**没有**模拟：Cordis 真实加载和依赖注入过程、`cordis.patch.yml` 的解析与合并、`dsh plugin add` 安装流程、提示词变量插值、真实模型如何决定调用哪个工具、dsh-qqbot 的消息流。这些只能在真实 DSH 里验证。

接口依据（2026-10-25 读取 deepseek-ai/deepseek-harness 0.2.1-rc.3 源码）：`packages/core/system-prompt/src/index.ts`（`PromptSection`、`SECTION_ORDERS`）、`packages/core/tools/src/index.ts` 与 `json-schema.ts`（`register`、支持的关键字）、`packages/core/agent/src/runtime-types.ts`（agent 事件）、`packages/core/session/src/index.ts`（`session/event`、`Session.id`）、`vendor/cordis/src/fiber.ts`（`Config['~standard'].validate`）。

## 插件测试覆盖

- `Config`：默认值、覆写、错误类型、未知键、越界的 `maxChars` 都按 Standard Schema 返回 issues。
- 数据目录：`$DSH_HOME`、相对路径、绝对路径、默认 `~/.dsh/more-than-7s`。
- 注册：四个工具；已有会话和之后创建的会话各有一个记忆段（`interpolate: false`，order 在 0–500 之间）；会话销毁和插件卸载后都清理干净；`enabled: false` 时什么都不注册。
- 写入：原话有标点或空格差异也能通过；重启后新会话能看到；`memories.json` 和 `我眼中的你.md` 都正确。
- 拒绝：编造的原话、模型回复里的话、非用户来源的注入消息、别的会话里的话、超出最近 6 句的旧话、太短的引用。被拒时不创建档案文件。`requireQuote: false` 可放行。
- 卡片规则：关于你、相处习惯、你不喜欢的默认置顶，说好的事和故事不置顶；同 key 覆盖；参数非法时工具报错。
- 画像：按 about / habits / dislikes / impressions / promises / stories 分组；`recentDays` 内的故事和约定即使没提到也带上，最多 5 条，0 可关闭；预算紧张时按“你不喜欢的 → 关于你 → 相处习惯 → 我的感觉 → 与这句相关的卡 → 最近的事”保留；画像文件按六类整理；提示词鼓励察觉情绪、说出感觉，并禁止医学或心理诊断。
- 我的感觉：模型的推测记为 impression，默认置顶；来由必须是用户在本会话说过的话，凭空的感觉被拒绝；画像文件标明是猜测并写出“让我这样觉得的话”；用户否认后可以忘掉。
- 改口和忘记：`#` 短编号、唯一前缀、完整 ID；编号不存在或有歧义时不改动；同样要求原话。
- 召回：两个会话各按自己最新一句召回；字符预算不超限。
- 故障：档案损坏时不覆盖、不注入，工具报错；目录只读导致写入失败时，内存与磁盘都保持原状；5 个会话并发写入全部落盘。
- `fish_list` 超过 100 条时说明省略了多少。

## 召回评估（`npm run eval`）

| 类别 | top-4 | context | 说明 |
| --- | :-: | :-: | --- |
| 原词复现 | 6/6 | 6/6 | 共同叫法、宠物名、约定、中英混写都能找回 |
| 同义改写 | 0/5 | 0/5 | “面试→应聘”“猫咪→喵星人”等全部找不到 |
| 改口与冲突 | 4/4 | 4/4 | 同 key 改口只剩新说法；无 key 的新旧说法靠 `date` 区分 |
| 不该想起 | 5/5 | 5/5 | 停用词表与这些用例同时编写，属于样本内结果 |
| 置顶挤占 | 0/2 | 1/2 | 置顶卡总排在前；12 条长置顶时相关经历放不进 2000 字符 |

插件注入给模型的是 context 那一列。top-4 是 `recall()` 默认返回的条数，插件本身不直接使用。

## 尚未验证

- 在真实 DSH（需要 Node 24.9+ 的开发环境，或 DSH 桌面版）中安装、加载和配置覆写。
- 真实 DeepSeek 模型是否会在合适的时候调用工具、是否会照抄原话。
- 与 dsh-qqbot 一起使用时的实际消息流。
- GitHub Actions、Node 24 和 Linux（仅有工作流配置；仓库尚无 Git 历史）。
- 多个 DSH 进程共用一个数据目录、长期运行。

没有进行外部消息发送、公开仓库创建、npm 发布，也没有改动本机的 DSH 配置。
