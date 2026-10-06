# Evolyn

简体中文（默认） | [English](agent-harness/README.md)

**一个 durable、可自我进化的 coding agent——构建在 [Pi](https://github.com/earendil-works/pi) 的低层 agent 运行时之上（loop、工具、streaming 直接复用），补齐 Pi 没有提供的层：run 级持久执行、可查询的执行轨迹、权限与预算、经验记忆、技能自进化闭环。**

## 快速开始

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 完整测试套件——全部无需 API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

要求 Node ≥ 22.19（内置 `node:sqlite`）。Provider：`deepseek/*`、`qwen/*`（DashScope）、`openrouter/*`、`openai/*`、`anthropic/*`——key 从环境变量读取。工具调用默认**交互式审批**；`--yolo` 显式跳过。CI 在 windows/ubuntu × Node 22/24 矩阵上运行构建、类型检查、lint 与全部测试。

## 核心能力

- **持久执行与崩溃恢复**——每个 run 在消息边界落 checkpoint；进程被杀后在**同一 runId** 上恢复，trace 序列续号，工具集从 run 行持久化的规格自动还原。未决工具调用按规则结算：用日志里的结果重建 / 过门重执行（幂等工具）/ 合成"结果未知"错误回喂模型——**绝不幻觉成功**。"僵尸 run"自愈；首个 trace 事件落盘前被杀的 run 按证据决定重启或拒绝重启。
- **崩溃可复现**——故障注入（`--fault point:tool`）在精确位置杀进程（工具调用后、执行中途、两份 trace sink 之间、"planned"窗口、恢复过程中途），恢复因此可测试，不是表演。
- **执行即数据库**——每个事件以同一序列号双写 JSONL 与 SQLite；`trace summary / replay / query` 回答任意 run 的"做了什么、为什么"，可跳到任意历史序列号做 debugger 式状态检查。sink 失败留下可容忍的补洞，而不是一条坏日志。
- **安全与护栏**——按 run 授予能力（`fs:read/write`、`process:exec`、`net:outbound`、`notify:send`）、风险分级、显示实际参数的交互审批、路径围栏（词法 + realpath）与状态目录写围栏；回合数 / 工具调用数 / 同参重复 / 成本 / token / 工具超时六类失控熔断。违规即把 run 降级为 `failed` 并附原因。
- **上下文工程**——围绕块模型的两层上下文管理：第一层确定性整理旧工具结果，第二层模型驱动的滚动摘要；每次请求产出服务 prompt cache 的 `prefix_decision`（reuse / defer / compact / rebuild）。原始历史 append-only，只产出投影。
- **只读子代理**——`explore` 派生独立上下文窗口的只读子 Agent（无 shell、无递归），最终回答作为工具结果返回，中间读取永不进入父对话；用量计入父 run 熔断，崩溃经普通恢复路径整体重跑。
- **经验记忆**——跨 run 的双层经验：结构化 Core Memory（证据强制）+ Markdown 普通记忆（乐观锁、history 快照、容量硬顶），写入过三道闸；FTS + 本地向量混合检索，降级链显式，没建过向量的 run 零模型开销。
- **技能自进化**——从 trace 挖重复模式（support ≥ 3 硬门槛），蒸馏成 pi 兼容 `SKILL.md`，经 Pi 自己的 loader 复验后注入后续 run；注入内容带溯源标记与结构转义，无法冒充系统指令。
- **评测框架**——确定性判分、协议钉死、基础设施失败防线（详见 [评测](#评测)）。
- **数据保留**——`harness prune` 清理已完成 run 的 checkpoint、持久化水位线与超窗的 trace/evidence。

## 架构

主项目在 [`agent-harness/`](agent-harness/)，全部源码位于 [`agent-harness/src/`](agent-harness/src/)；每个模块依赖轻量、单测无 API key 可跑。

| 模块 | 职责 |
|---|---|
| `runtime/` | run 生命周期。`RunManager.run/resume` 驱动 Pi `Agent`；`composeRuntime()` 是工具包装链（fault → evidence → timeout → retry）与组合门（限额 → 权限）的唯一组装点，run、resume 与 explore 子代理共用；`demo` / `coding` 两套工具集叠加能力/风险/`replay` 元数据 |
| `execution/` | 持久化内核。消息边界 checkpoint（永远滞后于 trace）、故障注入点、仅凭持久化数据重建崩溃时刻并逐调用规划结算；滞后 checkpoint 交叉核对，矛盾以 degradation 警告上浮 |
| `trace/` | 事件溯源。版本化信封 + 双 sink（零缓冲 JSONL / SQLite）共享序列号；resume 前 reconcile 对齐；`replay.ts` 纯离线状态机重建任意序列号处的状态并解释"为什么" |
| `context/` | 模型视图。确定性组装 system prompt（字节级稳定）；块模型（四类块，tool_call id Counter 精确配对）；校准的 token 估算与六条预算线；第一层工具结果整理（头尾截断附 evidence 指针、最旧优先整轮移除、语义 JSON 裁剪）；第二层严格 JSON 滚动摘要（硬校验、水位线跨 resume 持久化、按引用与 tool_call_id 精确前缀替换）；`compaction` 编排 `prefix_decision` |
| `memory/` | 经验记忆（按 `memory-design.md` 组织）。M### Markdown 权威 + 派生索引；Core Memory 按 key upsert 强制证据；chunk 切块（900/180/16，sha256 内容身份）；FTS5 tokenizer 探测 + RRF 融合 + 有界 accessCount 提升；反思三道闸（确定性门控 → 严格 JSON 反思器 → 只允许更新本轮读过全文的记忆）；跨进程文件锁与唯一 tmp 原子写 |
| `learning/` | 自进化闭环。`miner` 提取工具序列与 error→repair 对（确定性 pattern id）；`candidate` 溯源蒸馏；`judge` 确定性判分（判分前从模板还原 fixture 测试文件——改测试不能让判分恒绿）；`protocol` 钉死评测协议（任务集 + 模型 + 工具集，sha256 可比） |
| `skills/` | pi 兼容 `SKILL.md` 格式校验；晋升由 Pi 自己的 `loadSkillsFromDir` 复验并受评测台账门控；检索以指针注入 |
| `storage/` | `node:sqlite` WAL（零原生依赖）、forward-only 迁移、runs / trace events / checkpoints / 上下文水位线 / memory / skills / evals 各表 repo |
| `llm/` | `completeStructured` 三级降级：直接解析 → 携解析错误 re-prompt → schema 工具约束解码兜底 |
| `cli/` | 单一二进制（见[命令一览](#命令一览)），TTY 交互审批、非 TTY 自动拒绝 |

跨模块不变量：转录与 trace **append-only**（压缩只产出投影）；`compose.ts` 是工具包装的唯一组装点；memory 以 **Markdown 为权威**、SQLite 只存可重建投影；恢复方向永远保守（未决调用宁可"结果未知"，绝不幻觉成功）；**决策即数据**——恢复结算、上下文决策、权限判断、评测还原全部作为审计事件落入 trace。

## 评测

三层，全部确定性、无 LLM judge（LLM 只在被显式配置的 judgeInstructions 任务上出场）：

- **单元/集成测试**——266 个测试，全部无 API key 可跑，进 CI 矩阵。
- **记忆检索质量门控**——`npm run eval:memory`（recall@5 + precision@5 + 盲区检查，fixture 见 [`agent-harness/evals/memory-retrieval.json`](agent-harness/evals/memory-retrieval.json)）进 CI；真实模型链路用 `npm run e2e:memory-hybrid` 验证（只进台账，不进 CI——30MB 模型下载）。
- **coding 任务 A/B**——`agent-harness skill baseline / skill eval`：任务集 + 模型 + 工具集钉死协议（sha256）、臂序交替、重复试验、Wilson 置信区间、最小 repeats 下限；判分看终态（fixture 自带 `npm test` / 文件内容逐项检查），判分前从模板还原 `test.js`/`package.json`——模型改测试文件无法让判分恒绿；基础设施失败（限流/配额/鉴权）标记报告 INVALID，进不了门控。

评测记录：`.claude/hillclimb/coding-tasks/`（基线 89/90 → prompt 调优后 90/90，out_tokens −22.4%，directional——15 例无 held-out split；含逐轮 change/results/summary 与最终报告）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `agent-harness run "<task>"` | 跑一个任务（`--model`、`--tools demo\|coding`、`--yolo`、`--capabilities`、`--fault`） |
| `agent-harness resume [runId]` | 在同一 runId 上恢复被中断的 run |
| `agent-harness trace show/summary/replay/query/list` | 查询与回放执行轨迹 |
| `agent-harness memory core/list/search/rebuild/status/history/distill` | 经验记忆的查看与运维 |
| `agent-harness skill mine/draft/promote/eval/baseline/list/retrieve/verify` | 技能挖掘、晋升与 A/B 评测 |
| `agent-harness models` | 列出 provider 与模型 |
| `agent-harness prune [--deep] [--dry-run]` | 数据保留清理 |
