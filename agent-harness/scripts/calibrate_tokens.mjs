#!/usr/bin/env node
// 校准闭环的"实测 → 校准"一环：用真实 Trace 样本检验 token 估算系数。
//
//   node scripts/calibrate_tokens.mjs [--traces .harness/traces] [--json]
//
// 原理：对每条 Trace 按序回放 message_end 事件重建转录；每遇到一条带 Usage
// 的 assistant 消息，就产生一个样本：
//   估算 = 基线字符启发式（chars/4，系数按 1 计）对"到目前为止的转录"求和
//   实测 = 该次请求的 Usage（input+output+cacheRead+cacheWrite，即 totalTokens）
//   ratio = 估算 / 实测
// 注意：Trace 永不包含合成的 system 消息（run_manager 存 runs 表），早期样本
// 会因此略偏低估——推荐系数取 P95 并保留安全余量，缺口由预算线兜底。
//
// 按 (provider, model family) 分组输出 P50/P95/min/max 与推荐系数；推荐值
// 与 src/context/tokens.ts 的 TOKEN_COEFFICIENTS 比对，低估风险大就上调。

import fs from "node:fs";
import path from "node:path";

const ESTIMATED_IMAGE_CHARS = 4800;

function contentChars(content) {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content ?? []) {
    if (block.type === "text" && block.text) chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
    else if (block.type === "thinking" && block.thinking) chars += block.thinking.length;
    else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
  }
  return chars;
}

/** 基线估算（chars/4），与 pi 的 estimateTokens 同口径；系数留给 ratio 推导。 */
function estimateTokens(message) {
  if (!message || typeof message !== "object") return 0;
  switch (message.role) {
    case "user":
    case "toolResult":
      return Math.ceil(contentChars(message.content) / 4);
    case "assistant":
      return Math.ceil(contentChars(message.content) / 4);
    case "system":
      return Math.ceil(contentChars(message.content) / 4);
    default:
      return Math.ceil(contentChars(message.content) / 4);
  }
}

function familyOf(provider, modelId) {
  const p = String(provider).toLowerCase();
  const id = String(modelId).toLowerCase();
  if (p === "qwen" || id.includes("qwen")) return "qwen";
  if (p === "deepseek" || id.includes("deepseek")) return "deepseek";
  if (p === "anthropic" || p === "amazon-bedrock" || id.includes("claude")) return "anthropic";
  if (p === "openai" || /^(gpt-|o\d)/.test(id)) return "openai";
  return "other";
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

function parseArgs(argv) {
  const args = { traces: ".harness/traces", json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--traces") args.traces = argv[++i];
    else if (argv[i] === "--json") args.json = true;
    else if (!argv[i].startsWith("--")) args.traces = argv[i];
  }
  return args;
}

function collectSamples(tracesDir) {
  const samples = [];
  if (!fs.existsSync(tracesDir)) return samples;
  for (const file of fs.readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"))) {
    const filePath = path.join(tracesDir, file);
    let family = "other";
    let provider = "?";
    let modelId = "?";
    let runId = file.replace(/\.jsonl$/, "").slice(0, 8);
    const transcript = [];
    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // 被杀进程留下的半行——容忍
      }
      if (event.type === "run_start") {
        [provider, modelId] = String(event.modelSpec ?? "?/?").split("/");
        family = familyOf(provider, modelId);
        runId = event.runId ?? runId;
        continue;
      }
      if (event.type !== "message_end" || !event.message) continue;
      const message = event.message;
      if (message.role === "assistant" && message.usage && message.stopReason !== "error") {
        const estimated = transcript.reduce((acc, m) => acc + estimateTokens(m), 0);
        const actual = message.usage.totalTokens || message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        if (actual > 0 && estimated > 0) {
          samples.push({ runId, provider, modelId, family, estimated, actual, ratio: estimated / actual });
        }
      }
      transcript.push(message);
    }
  }
  return samples;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = collectSamples(args.traces);
  if (raw.length === 0) {
    console.error(`no usable samples found in ${args.traces} — run some harness runs with tracing enabled first`);
    process.exitCode = 1;
    return;
  }
  // 固定开销过滤：trace 永不含 system prompt / 工具声明 / workspace 树，转录
  // 很小的样本会被这部分支配（ratio→0），对"转录文本系数"没有意义。只保留
  // 转录估算 ≥ 30% 实测的样本，其余剔除并计数。
  const DOMINATED = 0.3;
  const samples = raw.filter((s) => s.estimated >= DOMINATED * s.actual);
  const excluded = raw.length - samples.length;
  if (samples.length === 0) {
    console.error(
      `${raw.length} sample(s) found, all dominated by the missing system+tools overhead — ` +
        `need runs with longer transcripts (transcript estimate ≥ ${DOMINATED * 100}% of actual)`,
    );
    process.exitCode = 1;
    return;
  }
  const groups = new Map();
  for (const s of samples) {
    if (!groups.has(s.family)) groups.set(s.family, []);
    groups.get(s.family).push(s);
  }
  const report = [];
  for (const [family, group] of [...groups.entries()].sort()) {
    const ratios = group.map((s) => s.ratio).sort((a, b) => a - b);
    const p50 = percentile(ratios, 0.5);
    const p95 = percentile(ratios, 0.95);
    const worst = ratios[0];
    const best = ratios[ratios.length - 1];
    const recommended = Math.min(2, Math.max(Math.ceil(p95 * 100) / 100, Math.ceil(p50 * 1.15 * 100) / 100));
    report.push({ family, samples: group.length, p50, p95, worst, best, recommended });
  }
  if (args.json) {
    console.log(JSON.stringify({ samples: samples.length, excluded, report }, null, 2));
    return;
  }
  console.log(
    `calibration over ${samples.length} usable sample(s) from ${args.traces}` +
      (excluded > 0 ? ` (${excluded} excluded: transcript < ${DOMINATED * 100}% of actual — dominated by missing system+tools)` : ""),
  );
  console.log("ratio = baseline estimate (chars/4, coefficient 1) / actual usage");
  console.log("");
  for (const r of report) {
    console.log(
      `${r.family.padEnd(10)} n=${String(r.samples).padStart(4)}  P50=${r.p50.toFixed(2)}  P95=${r.p95.toFixed(2)}  min=${r.worst.toFixed(2)}  max=${r.best.toFixed(2)}  → recommended coefficient ${r.recommended}`,
    );
  }
  console.log("");
  console.log("compare with TOKEN_COEFFICIENTS in src/context/tokens.ts; raise a coefficient");
  console.log("when its P95 ratio shows underestimation risk (safety margin + usage backstop cover the rest).");
}

main();
