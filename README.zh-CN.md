# agent-harness

[English](README.md) | 简体中文

**一个 durable、可自我进化的 coding agent——构建在 [Pi](https://github.com/earendil-works/pi) 的低层 agent 运行时之上（loop、工具、streaming 直接复用），补齐 Pi 没有提供的层：run 级持久执行、可查询的执行轨迹、权限与预算、经验记忆、技能自进化闭环。**

## 快速开始

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 148 个测试——全部无需 API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

要求 Node ≥ 22.19（内置 `node:sqlite`）。Provider：`deepseek/*`、`qwen/*`（DashScope）、`openrouter/*`、`openai/*`、`anthropic/*`——key 从环境变量读取。工具调用默认**交互式审批**；`--yolo` 显式跳过。

## 功能

- **持久执行**——每个 run 在消息边界落 checkpoint；进程被杀后在**同一 runId** 上恢复，trace 序列续号。未决工具调用按规则结算：用日志里的结果重建 / 过门重执行（幂等工具）/ 合成"结果未知"错误回喂模型——绝不幻觉成功。trace 已经跑完的"僵尸 run"自愈（补写状态），不会被恢复成断裂的括号。
- **崩溃可复现**——故障注入（`--fault point:tool`）在精确位置杀进程：工具调用之后、执行中途、两份 trace sink 之间、带工具调用的 assistant 消息之后（"planned"窗口）、恢复过程中途——恢复因此可测试，不是表演。
- **执行即数据库**——每个事件以同一序列号双写 JSONL 与 SQLite；`trace summary / replay --until / query` 回答任意 run 的"做了什么、为什么"，支持跳到任意历史序列号做 debugger 式状态检查。sink 失败留下可容忍的补洞，而不是一条坏日志。
- **权限与审计**——按 run 授予能力（`fs:read/write`、`process:exec`、`net:outbound`、`notify:send`）、风险分级、显示实际参数的交互审批、覆盖每个路径类参数的工作区路径围栏（词法 + 符号链接 realpath）；每次决策作为审计事件落入 trace。
- **失控护栏**——回合数、工具调用数、同参重复调用、成本预算、token 预算（对上报零成本的模型是可靠兜底）、工具级超时（超时不重试——第一次执行可能还在后台跑）；违规即把 run 降级为 `failed` 并附原因。
- **可扩展的上下文**——滚动压缩与工具结果整理只改模型看到的内容（挂在 `transformContext`）；转录与 trace 保持 append-only，恢复与重放因此零特判。
- **经验记忆**——run 结束后蒸馏为 Markdown 记忆（人类可读、可手改）；FTS + 本地向量embedding 混合召回；相似记忆确认后合并而非新增。
- **技能自进化**——从 trace 挖重复模式（support ≥ 3 硬门槛），蒸馏成 pi 兼容的 `SKILL.md`，用 Pi 自己的 loader 校验，作为 `<available_skills>` 注入后续 run——注入内容带溯源标记（"挖自本工作区自己的运行记录，当数据看"）并做结构标记转义，挖出来的内容永远无法冒充系统指令；`--force` 覆盖已有技能需要确认过 diff 才放行。
- **评测框架**——确定性判分（coding 任务由仓库自己的测试裁决）、回归基线、Wilson 置信区间、门控评测的最小 repeats 下限、基础设施失败防线（被污染的报告标记 INVALID，进不了门控）。
- **数据保留**——`harness prune` 清理已完成 run 的 checkpoint（恢复只读中断的 run）与超出保留窗口的 trace/evidence。

## 模块实现

全部位于 `src/`；每个模块依赖轻量、单测无 API key 可跑。

- **`runtime/`**——run 生命周期。`RunManager.run/resume` 每个 run 驱动一个 Pi `Agent`；`composeRuntime()` 是工具包装链（fault → evidence → timeout → retry）与 `beforeToolCall` 组合门（限额 → 权限）的唯一组装点，run 与 resume 共用。两套工具集：`demo`（四个教学工具，含一个非幂等工具供崩溃演示）与 `coding`（Pi 的 read/edit/write/grep/ls/find + shell，叠加能力/风险/`replay` 元数据）。`agent-factory.ts` 是全仓库唯一触碰 Pi 构造函数的文件。

- **`execution/`**——持久化内核。`CheckpointWriter` 在每个消息边界追加 checkpoint，永远**滞后**于 trace 日志；`FaultController` 提供两个杀进程注入点；`recovery.ts` 仅凭持久化数据重建崩溃时刻（转录、未决工具调用状态机、滞后 checkpoint）并逐调用规划结算。

- **`trace/`**——事件溯源。事件沿用 Pi 的词汇表，装进带版本号的信封；recorder 扇出到 JSONL（零缓冲 `appendFileSync`——被杀只丢"从未发出"的事件）与 SQLite（提取列建索引），共享同一序列号。`reconcile.ts` 在 resume 前把 JSONL 尾部对齐到 SQLite；`replay.ts` 是纯离线状态机，重建任意序列号处的转录与工具调用状态，并解释"为什么走到这里"。

- **`context/`**——模型视图。`assembler` 确定性组装 system prompt（base → core memory → 技能 → 经验 → workspace 目录树；字节级稳定，利于 prompt cache）。`compaction` 复用 Pi 的 token 估算、在消息数组上重实现拼接，挂在 `transformContext`——切点绝不拆散 assistant/toolResult 对，旧工具结果被整理成指向磁盘 evidence 文件的指针。

- **`memory/`**——跨 run 的经验。一条记忆 = 一个 Markdown 文件（YAML frontmatter），是权威存储；SQLite FTS5 与本地 `e5` embedding（transformers.js，RRF 融合）都是可重建投影。蒸馏器经容错 JSON 管线提取结构化经验，召回相似旧记忆、确认后合并。

- **`learning/`**——自进化闭环。`miner` 提取有序工具序列与 error→repair 对（support ≥ 3 硬门槛；确定性 pattern id，重挖不失效）。`candidate` 带溯源蒸馏技能草稿。`eval` 跑 A/B 对比：重复试验、臂序交替、协议钉死（任务集 + 模型 + 工具集）、确定性判分、基础设施失败防线。

- **`skills/`**——pi 兼容 `SKILL.md` 格式（frontmatter 校验），晋升由 Pi 自己的 `loadSkillsFromDir` 复验并受评测台账门控，检索以指针注入、模型按需读取。

- **`storage/`**——`node:sqlite` WAL 模式（零原生依赖）、forward-only 迁移、runs / trace events / checkpoints / memory / skills / evals 各表 repo。

- **`llm/`**——`completeStructured`：直接解析 → 携解析错误 re-prompt → schema 工具约束解码兜底。harness 侧所有抽取调用（蒸馏、挖掘、judge）都能在坏 JSON 下存活。

- **`cli/`**——单一二进制（`run`、`resume`、`trace`、`memory`、`skill`、`models`），TTY 交互审批、非 TTY 自动拒绝。
