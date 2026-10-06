# Evolyn

简体中文（默认） | [English](agent-harness/README.md)

**一个 durable、可自我进化的 coding agent**——构建在 [Pi](https://github.com/earendil-works/pi) 的低层 agent 运行时之上。Pi 提供 loop、工具与 streaming；本项目补上它没有的层：run 级持久执行、可查询的执行轨迹、权限与预算、经验记忆、技能自进化闭环。

## 快速开始

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 完整测试套件——全部无需 API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

要求 Node ≥ 22.19（内置 `node:sqlite`）。Provider：`deepseek/*`、`qwen/*`（DashScope）、`openrouter/*`、`openai/*`、`anthropic/*`——key 从环境变量读取。工具调用默认**交互式审批**；`--yolo` 显式跳过。CI 在 windows/ubuntu × Node 22/24 矩阵上运行构建、类型检查、lint 与全部测试。

## 交互模式（chat）

```powershell
npm run harness -- chat --model deepseek/deepseek-flash --tools coding
```

Claude Code 风格的 TUI：流式 markdown、工具卡片（edit 渲染 diff、shell 渲染输出尾部）、运行中插话（steer）、`Esc` 打断、带自动补全的斜杠命令（`/help /model /yolo /approval /tools /memory /trace /compact /clear /quit`）、审批对话框。TTY 下裸命令 `agent-harness` 等价于 `chat`；脚本场景请用 `run`。

交互会话就是一个**持久 run**：trace 括号贯穿整个对话，`resume <runId> --chat` 可在 TUI 里恢复并继续同一个对话。回合数/工具调用数等失控熔断按每次提交重置；成本/token 熔断按整个会话累计。

## 核心能力

- **持久执行**——run 在消息边界落 checkpoint；进程被杀后在**同一 runId** 续跑（trace 序列续号、工具集从 run 行自动还原）。未决工具调用按规则结算：重建 / 过门重执行 / 合成"结果未知"错误——**绝不幻觉成功**；账本模糊时拒绝恢复，宁可不跑也不重复副作用。
- **崩溃可复现**——故障注入在精确位置杀进程（工具调用后、执行中途、两份 trace sink 之间、"planned"窗口、恢复中途），恢复因此可测试，不是表演。
- **执行即数据库**——每个事件以同一序列号双写 JSONL 与 SQLite；`trace summary / replay / query` 回答任意 run 的"做了什么、为什么"，可跳到任意历史序列号做 debugger 式检查。
- **权限与护栏**——按 run 授予能力（`fs:read/write`、`process:exec`、`net:outbound`、`notify:send`）、风险分级、显示实际参数的交互审批、工作区路径围栏与状态目录写围栏（改了 database/traceDir 位置也覆盖）；回合数 / 工具调用数 / 同参重复 / 成本 / token / 工具超时六类熔断，违规即失败并附原因。
- **上下文工程**——围绕块模型的两层上下文管理（第一层确定性整理工具结果、第二层严格 JSON 滚动摘要）；每次模型调用产出服务 prompt cache 的 `prefix_decision`（reuse / defer / compact / rebuild）。原始历史与 trace 永远 append-only，压缩只产出投影。
- **只读子代理**——`explore` 派生独立上下文窗口的只读子 Agent（无 shell、无递归）；中间读取永不进入父对话，子代理崩溃经普通恢复路径整体重跑。
- **经验记忆**——双层经验：证据强制的 Core Memory + Markdown 普通记忆（乐观锁、history 快照、容量硬顶），写入过三道闸；FTS + 本地向量混合检索，降级链显式（每个结果带 `mode` 与原因），没建过向量的 run 零模型开销。
- **技能自进化**——从本工作区自己的 trace 挖重复模式（support ≥ 3 硬门槛），蒸馏成 pi 兼容 `SKILL.md` 注入后续 run；内容带溯源标记与结构转义，**挖出的内容永远无法冒充系统指令**。
- **评测框架**——确定性终态判分、协议钉死（任务集+模型+工具集 sha256）、Wilson 置信区间、基础设施失败防线；详见[评测](#评测)。
- **数据保留**——`harness prune` 清理已完成 run 的 checkpoint、上下文水位线与超窗的 trace/evidence。

## 仓库结构

```text
Evolyn/
  README.md          本文件（简体中文）| agent-harness/README.md（English）
  LICENSE            MIT
  docs/              设计文档
  .github/           CI（windows/ubuntu × Node 22/24）
  agent-harness/     主项目
    src/
      runtime/     run 生命周期——RunManager.run/resume 与交互式会话共用组装点；
                   工具包装链（fault → evidence → timeout → retry）与限额 → 权限组合门的唯一组装点
      execution/   持久化内核——滞后 checkpoint、故障注入、仅凭持久化数据重建崩溃时刻
      trace/       事件溯源——JSONL+SQLite 双 sink 共享序列号、reconcile、纯离线 replay 状态机
      context/     模型视图——确定性组装 system prompt、块模型、两层压缩、prefix_decision 循环
      memory/      跨 run 经验——Markdown 权威存储、Core Memory、混合检索、反思闸门、记忆工具面
      learning/    自进化闭环——模式挖掘、技能蒸馏、A/B 评测（含防绕过判分）
      skills/      pi 兼容 SKILL.md、评测台账门控的晋升、指针注入
      storage/     node:sqlite（WAL）、forward-only 迁移、各表 repo
      llm/         completeStructured——坏 JSON 下可存活的抽取调用
      cli/         单一二进制：run / chat / resume / trace / memory / skill / models / prune
      modes/       交互式 TUI（chat 视图、工具卡片、审批对话框）
    evals/         评测任务集 + fixture 仓库（memory-retrieval、coding-fix、file-creation、
                   file-precision、coding-hard、coding-compact、open-ended）
    scripts/       工具 CLI——eval:coding、eval:memory、e2e:memory-hybrid、
                   calibrate_tokens、chaos、export-traces
    tests/         完整套件——全部无需 API key
    .claude/       评测战役记录——每 flow 的基线、逐轮改动结果与 report.html
```

每个模块依赖轻量、单测无 API key 可跑。运行时状态在 `.harness/`（SQLite 台账、traces、memory、evidence），除 Markdown 记忆权威外全部可丢弃。

跨模块不变量：转录与 trace **append-only**（压缩只产出投影）；`compose.ts` 是工具包装的唯一组装点；memory 以 **Markdown 为权威**、SQLite 只存可重建投影；恢复方向永远保守（未决调用宁可"结果未知"，绝不幻觉成功）；**决策即数据**——恢复结算、上下文决策、权限判断、评测还原全部作为审计事件落入 trace。

## 评测

三层，全部确定性（LLM 只在被显式配置 `judgeInstructions` 的任务上出场）：

- **单元/集成测试**——283 个测试，全部无 API key 可跑，进 CI 矩阵。
- **记忆检索门控**——`npm run eval:memory`（recall@5 + precision@5 + 盲区检查）进 CI；真实模型链路用 `npm run e2e:memory-hybrid` 验证（只进台账，不进 CI——30MB 模型下载）。
- **coding agent 评测 runner**——`npm run eval:coding`：逐题沙箱隔离、终态确定性判分（fixture 自带测试 / 文件内容逐项检查，判分前从模板还原测试文件——改测试不能让判分恒绿）、逐题落盘可断点续跑、报告构建器与完整性闸门。

评测记录在 `.claude/hillclimb/`（每 flow 含基线、逐轮改动、结果与 `report.html`）：回归标尺 89/90 → 90/90（prompt 调优后 out_tokens −22.4%）；质量探针基线 96.2%；压缩保真度双盲（1/21 损伤、+15% token 税）；技能 A/B（三个晋升技能被读取但无可测收益）。

## 命令一览

| 命令 | 作用 |
|---|---|
| `agent-harness [chat]` | 交互式编码 agent（REPL，见[交互模式](#交互模式chat)） |
| `agent-harness run "<task>"` | 跑一个任务（`--model`、`--tools demo\|coding`、`--yolo`、`--capabilities`、`--fault`） |
| `agent-harness resume [runId] [--chat]` | 在同一 runId 上恢复被中断的 run；`--chat` 恢复后继续交互式对话 |
| `agent-harness trace show/summary/replay/query/list` | 查询与回放执行轨迹 |
| `agent-harness memory core/list/search/rebuild/status/history/distill` | 经验记忆的查看与运维 |
| `agent-harness skill mine/draft/promote/eval/baseline/list/retrieve/verify` | 技能挖掘、晋升与 A/B 评测 |
| `agent-harness models` | 列出 provider 与模型 |
| `agent-harness prune [--deep] [--dry-run]` | 数据保留清理 |
