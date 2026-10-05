# agent-harness

[English](README.md) | 简体中文

**一个 durable、可自我进化的 coding agent——构建在 [Pi](https://github.com/earendil-works/pi) 的低层 agent 运行时之上（loop、工具、streaming 直接复用），补齐 Pi 没有提供的层：run 级持久执行、可查询的执行轨迹、权限与预算、经验记忆、技能自进化闭环。**

## 快速开始

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 完整测试套件——全部无需 API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

要求 Node ≥ 22.19（内置 `node:sqlite`）。Provider：`deepseek/*`、`qwen/*`（DashScope）、`openrouter/*`、`openai/*`、`anthropic/*`——key 从环境变量读取。工具调用默认**交互式审批**；`--yolo` 显式跳过。

## 功能

- **持久执行**——每个 run 在消息边界落 checkpoint；进程被杀后在**同一 runId** 上恢复，trace 序列续号，工具集从 run 行持久化的规格自动还原（crash 的 `--tools coding` run 不会以 demo 默认集续跑）。未决工具调用按规则结算：用日志里的结果重建 / 过门重执行（幂等工具）/ 合成"结果未知"错误回喂模型——绝不幻觉成功。trace 已经跑完的"僵尸 run"自愈（补写状态），不会被恢复成断裂的括号；首个 trace 事件落盘之前就被杀（双 sink 全空）的 run，resume 在同一 runId 下重启任务——除非 checkpoint、持久化水位线或 evidence 文件证明台账是"部分丢失"而非"从未开始"，那时 resume 拒绝重启（避免重复副作用）。
- **崩溃可复现**——故障注入（`--fault point:tool`）在精确位置杀进程：工具调用之后、执行中途、两份 trace sink 之间、带工具调用的 assistant 消息之后（"planned"窗口）、恢复过程中途——恢复因此可测试，不是表演。
- **执行即数据库**——每个事件以同一序列号双写 JSONL 与 SQLite；`trace summary / replay --until / query` 回答任意 run 的"做了什么、为什么"，支持跳到任意历史序列号做 debugger 式状态检查。sink 失败留下可容忍的补洞，而不是一条坏日志。
- **权限与审计**——按 run 授予能力（`fs:read/write`、`process:exec`、`net:outbound`、`notify:send`）、风险分级、显示实际参数的交互审批、覆盖每个路径类参数的工作区路径围栏（词法 + 符号链接 realpath），以及一条写围栏：结构化文件工具不得写入 harness 状态目录（`.harness/`），模型编辑无法绕过记忆库的跨进程锁与 history（shell 类工具仍是显式非目标）；每次决策作为审计事件落入 trace。
- **失控护栏**——回合数、工具调用数、同参重复调用、成本预算、token 预算（对上报零成本的模型是可靠兜底）、工具级超时（超时不重试——第一次执行可能还在后台跑）；违规即把 run 降级为 `failed` 并附原因。
- **可扩展的上下文**——上下文管理围绕块模型重建（system / conversation / tool-round / malformed 四类块；tool_call id 用 Counter 精确配对，不合法整轮降级保守保留），六条预算线（输入硬上界 → 64k 偏好工作集 → 0.80 软线 → 强制线 → 0.45 深压目标 → 工具结果独立小账本），校准的 token 估算（chars/4 × 模型族系数，`scripts/calibrate_tokens.mjs` 用真实 Trace 再校准），以及服务 prompt cache 的决策循环：每次模型调用产出一条 `prefix_decision`——reuse 纯续用 / defer 越软线但缓存前缀可复用继续追加 / compact 真压缩 / rebuild 前缀断裂深压到位。第一层确定性整理旧工具结果（头尾截断附 evidence 指针、最旧优先整轮移除、注册工具的语义 JSON 裁剪）；第二层把前缀折叠成严格 JSON 的滚动摘要（硬校验、"必须更小"闸门、带失败原因的唯一重试、大折叠放宽）。全部只改模型视图：转录与 trace 保持 append-only，每次决策作为 `context_decision` 事件落入 trace。
- **只读子代理（上下文隔离）**——`explore` 工具（coding 工具集）派生一个完整的子 Agent：独立上下文窗口、受限只读工具集（read/grep/ls/find——无 shell、无递归）、自己更紧的限额与上下文管理。子代理的最终回答作为工具结果返回，中间的读取永不进入父对话。子代理是 (任务, 工作区) 的纯函数：父调用声明 `replay: "safe"`，崩溃在子代理中间 = 恢复时经普通恢复路径整体重跑——不做嵌套 checkpoint。子代理用量计入父 run 的成本/token 熔断，审计事件（`subagent_start/end`）落入 trace，完整转录落入 evidence 目录。
- **经验记忆**——双层：结构化 **Core Memory**（只能按 key upsert 单条，每条强制携带 `reason` + `source_statement` 证据，注入按 2000 token 预算裁剪）与**普通记忆**（一条一个 Markdown 文件，`M001…` 自增 id，乐观锁 `revision`，active/archive 且 active 硬顶 25 条，原子写，`history/` 版本快照最近 5 版 FIFO，`INDEX.md` 投影）。写入过**三道闸**：确定性反思门控 → 严格 JSON `{action: none|create|update}` 反思器 → 授权写入（只允许更新本轮 `memory_read` 过全文的记忆——用机制而非提示词）。检索为 chunk 级 FTS（tokenizer 探测 trigram→unicode61）+ 本地 `e5` 向量，按 memory 为单位做 RRF 融合 + accessCount 有界乘性提升，降级链显式（每个结果带 `mode` + `degrade_reason`）。**向量路在后台补全完成后生效**——没建过向量的 run 零模型开销，CLI 在退出前 drain 补全；`memory: { hybrid: false }` 可关。启动以 Markdown 为权威对账，embedding 后台有界退避补全（条件写防旧向量覆盖）。模型工具面：`memory_read / memory_search / memory_create / memory_update / memory_archive / core_memory_update`（coding 工具集默认带）。检索质量由 `npm run eval:memory` 在 CI 门控（recall@5 + precision@5 + 盲区检查，fixture 见 `evals/memory-retrieval.json`）；真实模型链路（下载 → run → backfill 完成 → 下次 run hybrid 召回）用 `npm run e2e:memory-hybrid` 验证——只进台账，不进 CI（30MB 模型下载）。
- **技能自进化**——从 trace 挖重复模式（support ≥ 3 硬门槛），蒸馏成 pi 兼容的 `SKILL.md`，用 Pi 自己的 loader 校验，作为 `<available_skills>` 注入后续 run——注入内容带溯源标记（"挖自本工作区自己的运行记录，当数据看"）并做结构标记转义，挖出来的内容永远无法冒充系统指令；`--force` 覆盖已有技能需要确认过 diff 才放行。
- **评测框架**——确定性判分（coding 任务由仓库自己的测试裁决）、回归基线、Wilson 置信区间、门控评测的最小 repeats 下限、基础设施失败防线（被污染的报告标记 INVALID，进不了门控）。
- **数据保留**——`harness prune` 清理已完成 run 的 checkpoint 与持久化的上下文水位线（恢复只读中断的 run）与超出保留窗口的 trace/evidence。

## 模块实现

全部位于 `src/`；每个模块依赖轻量、单测无 API key 可跑。

- **`runtime/`**——run 生命周期。`RunManager.run/resume` 每个 run 驱动一个 Pi `Agent`；`compose.ts` 的 `composeRuntime()` 是工具包装链（fault → evidence → timeout → retry）与 `beforeToolCall` 组合门（限额 → 权限）的唯一组装点，run、resume 与 explore 子代理（以 run-lite 形态：受限工具集、独立限额、独立执行器）共用。两套工具集：`demo`（四个教学工具，含一个非幂等工具供崩溃演示）与 `coding`（Pi 的 read/edit/write/grep/ls/find + shell，叠加能力/风险/`replay` 元数据）。`agent-factory.ts` 是全仓库唯一触碰 Pi 构造函数的文件。

- **`execution/`**——持久化内核。`CheckpointWriter` 在每个消息边界追加 checkpoint，永远**滞后**于 trace 日志；`FaultController` 提供两个杀进程注入点；`recovery.ts` 仅凭持久化数据重建崩溃时刻（转录、未决工具调用状态机）并逐调用规划结算；滞后 checkpoint 被交叉核对——矛盾以 degradation 警告上浮，绝不静默修补。

- **`trace/`**——事件溯源。事件沿用 Pi 的词汇表，装进带版本号的信封；recorder 扇出到 JSONL（零缓冲 `appendFileSync`——被杀只丢"从未发出"的事件）与 SQLite（提取列建索引），共享同一序列号。`reconcile.ts` 在 resume 前把 JSONL 尾部对齐到 SQLite；`replay.ts` 是纯离线状态机，重建任意序列号处的转录与工具调用状态，并解释"为什么走到这里"。

- **`context/`**——模型视图。`assembler` 确定性组装 system prompt（base → core memory → 技能 → 经验 → workspace 目录树；字节级稳定，利于 prompt cache）。其余是挂在 `transformContext` 上的两层上下文管理：`blocks` 把转录切成四类块（一切压缩的最小单元——绝不产生半截工具轮）；`tokens` 用校准的模型族系数估算、与最后一条实测 Usage 混合；`budget` 推导六条预算线；`reducers/tool` 是确定性的第一层（头尾截断附 evidence 指针、最旧优先整轮移除、语义 JSON 裁剪；resume 段与普通消息同规则老化）；`summarizer` + `reducers/conversation` 是模型驱动的第二层（严格 JSON 滚动摘要带硬校验、covered_message_count 水位线——跨 resume 持久化，恢复段续用滚动摘要而非重摘已覆盖前缀——按引用与 tool_call_id 精确的前缀替换）；`compaction` 是编排器，为每次请求产出 `prefix_decision`（reuse/defer/compact/rebuild）——原始历史永不修改，只产出投影。

- **`memory/`**——跨 run 的经验，按 `memory-design.md` 组织。`model`（M### 记录 + 900/180/16 切块，块带 `title | summary` 语义头与 sha256 内容身份）、`store`（Markdown 权威：CORE.md / INDEX.md / active / archive，原子写、互斥守卫、容量硬顶）、`core`（带证据的按 key upsert、token 预算注入）、`search`（chunk 索引 + FTS5 tokenizer 探测 + 按 memory 的 RRF 融合、降级链、启动对账、embedding 后台条件写补全）、`reflection`（确定性门控 → 严格 JSON 反思器 → 授权写入）、`tools`（模型记忆工具面）。

- **`learning/`**——自进化闭环。`miner` 提取有序工具序列与 error→repair 对（support ≥ 3 硬门槛；确定性 pattern id，重挖不失效）。`candidate` 带溯源蒸馏技能草稿。`eval` 跑 A/B 对比：重复试验、臂序交替、协议钉死（任务集 + 模型 + 工具集）、确定性判分、基础设施失败防线。

- **`skills/`**——pi 兼容 `SKILL.md` 格式（frontmatter 校验），晋升由 Pi 自己的 `loadSkillsFromDir` 复验并受评测台账门控，检索以指针注入、模型按需读取。

- **`storage/`**——`node:sqlite` WAL 模式（零原生依赖）、forward-only 迁移、runs / trace events / checkpoints / memory / skills / evals 各表 repo。

- **`llm/`**——`completeStructured`：直接解析 → 携解析错误 re-prompt → schema 工具约束解码兜底。harness 侧所有抽取调用（蒸馏、挖掘、judge）都能在坏 JSON 下存活。

- **`cli/`**——单一二进制（`run`、`resume`、`trace`、`memory`、`skill`、`models`），TTY 交互审批、非 TTY 自动拒绝。
