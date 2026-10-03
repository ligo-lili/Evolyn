# Evolyn

简体中文（默认） | [English](agent-harness/README.md) | [中文详细文档](agent-harness/README.zh-CN.md)

**一个 durable、可自我进化的 coding agent——构建在 [Pi](https://github.com/earendil-works/pi) 的低层 agent 运行时之上（loop、工具、streaming 直接复用），补齐 Pi 没有提供的层：run 级持久执行、可查询的执行轨迹、权限与预算、经验记忆（按 `memory-design.md` 设计实现）、技能自进化闭环。**

## 仓库结构

- [`agent-harness/`](agent-harness/) — 主项目。durable execution harness：崩溃恢复与故障注入、双写 trace（JSONL + SQLite）与离线 replay、能力/审批/围栏、两层上下文管理、经验记忆、技能自进化、评测框架。

## 快速开始

```powershell
git clone https://github.com/ligo-lili/Evolyn
cd Evolyn\agent-harness
npm install
npm test          # 219 个测试——全部无需 API key
npm run harness -- run "<task>" --model deepseek/deepseek-flash --tools coding --yolo
```

要求 Node ≥ 22.19（内置 `node:sqlite`）。Provider：`deepseek/*`、`qwen/*`（DashScope）、`openrouter/*`、`openai/*`、`anthropic/*`——key 从环境变量读取。工具调用默认**交互式审批**；`--yolo` 显式跳过。

功能总览、模块说明与设计细节见 [`agent-harness/README.zh-CN.md`](agent-harness/README.zh-CN.md)（English: [`agent-harness/README.md`](agent-harness/README.md)）。CI 在 windows/ubuntu × Node 22/24 矩阵上运行构建、类型检查、lint 与全部测试。
