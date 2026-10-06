# coding-tasks-compact 评测输入集（baseline 候选）

- **流程**：与 coding 两条线相同（`RunManager` + coding 工具集，沙箱 cwd），独立 flow
  `.claude/hillclimb/coding-tasks-compact/`。测的**不是任务能力，而是上下文压缩的保真度**：
  长相位任务跑到中段时，两层压缩（确定性工具结果裁剪 + 滚动摘要折叠）已经处理过早期内容，
  最终产物是否仍正确。
- **判分**：纯确定性、看终态（单文件逐行精确比对）。判分前按模板还原 `test.js`+`package.json`
  （防绕过，标准行为）。
- **A/B 设计（核心）**：
  - **compact 臂**（`--variant baseline --preference-tokens 10240`）：小预算触发压缩——失败即压缩损伤。
  - **control 臂**（`--variant v1 --preference-tokens 1000000`）：预算拉高、压缩永不触发——证明任务本身可解，
    把 compact 臂的失败归因给压缩而非能力。
  - **阈值口径**：10240 是**测试缩放**值（生产默认 65536）；两臂跑同一条代码路径，差异只在触发点，
    记录里显式标注该偏差（压缩逻辑本身相同）。
- **关键设计：mandatory-recall 机制**——3 道题的正确终态依赖**已离开工作区可复现范围**的信息：
  `recall-token` 的种子被覆盖（重跑 gen.js 得到的是新 token）、`recall-tag` 的 cfg.json 被删除、
  `fix-factor` 的中间总量由模型自己算出且 first.txt 被删除。这些信息只能来自会话记忆（原始值或摘要），
  结构性排除"重读文件"这条捷径。其余 4 题为长程保真题（8 篇 balloon + 精确末态），
  可复现但测长上下文下的持续精确性。
- **Balloon**：每题中段要求读 8 篇 docs（合计 ~51.5k 字符 ≈ **12.9k 估计 token**）——稳定越过
  preferenceTokens=10240 的软线（~8.2k），保证 compact 臂真的触发压缩、control 臂真的不触发。
- **Oracle 已于 2026-10-06 复验**：7/7 参考解过判分、空输出必挂；balloon 尺寸实测打印。
  生成器与 oracle 留档在 `_tools/`（可重生成、可重验）。
- **协议**：model = `deepseek/deepseek-flash`，reps = 3（初拟），auto-approve，无 skill 注入；
  评测基础设施由闸门保护。

## 总表

| # | tag | id | 判分 | mandatory-recall 机制 |
|---|-----|----|------|----------------------|
| 1 | mandatory-recall | recall-token | proof.txt 精确 3 行 | 首 token 的种子被覆盖（重跑不可得） |
| 2 | mandatory-recall | recall-tag | audit.txt 精确 9 行 | tag 的来源文件被删除 |
| 3 | mandatory-recall | fix-factor | final.txt 精确 1 行 | 中间总量 T 由模型算出、first.txt 被删除 |
| 4 | long-fidelity | amend-rename | manifest.txt 精确 8 行 | —（长程格式化+改名一致性） |
| 5 | spec-early | spec-early-1 | out_data.txt 精确 1 行 | 格式规范文件读完即删除 |
| 6 | spec-early | spec-early-2 | summary.txt 精确 1 行 | 同上（不同规范） |
| 7 | long-fidelity | balloon-stress | counts.txt 精确 10 行 | —（8 篇语料词数 + 源文件统计） |

## 逐题

### 1. mandatory-recall / recall-token
```
Work in the workspace step by step. (a) Run `node gen.js` once and note the token it prints. (b) Overwrite seed.txt so it contains exactly the single line `beta`, then run `node gen.js` again and note the second token. (c) Read all eight files under docs/ (d01.txt through d08.txt). (d) Create proof.txt with exactly three lines: the FIRST token on line 1, the SECOND token on line 2, and on line 3 the first word of docs/d08.txt.
```

### 2. mandatory-recall / recall-tag
```
Work step by step. (a) Read cfg.json and note its tag value. (b) Delete cfg.json. (c) Read all eight files under docs/ (d01.txt through d08.txt). (d) Create audit.txt: the first line is `tag: <the tag from cfg.json>`, followed by one line per docs file in filename order formatted `<filename>: <first word of that file>`.
```

### 3. mandatory-recall / fix-factor
```
Work step by step. (a) Compute the total T = (sum of the numbers in src/a.txt) + (sum of the numbers in src/b.txt) and create first.txt containing exactly `total=<T>`. (b) Read all eight files under docs/ and create notes.txt with one line per file: `<filename> words=<word count of that file>`. (c) Correction: your earlier total is superseded - delete first.txt and create final.txt containing exactly `final=<T + 100>` where T is the total you computed in step (a).
```

### 4. long-fidelity / amend-rename
```
Work step by step. (a) For each line `k=v` in items.txt create a file named `k_sum.txt` containing exactly one line: the key in UPPERCASE, a colon, a space, then the value. (b) Read all eight files under docs/. (c) Amendment: the naming rule changed - rename every file you created in (a) from `k_sum.txt` to `k_v2.txt` (uppercase key, content unchanged). (d) Create manifest.txt listing the final names of those eight files, one per line, sorted alphabetically.
```

### 5. spec-early / spec-early-1
```
Work step by step. (a) Read specs.txt carefully - it defines a format you must follow for a file you create later - then delete specs.txt. (b) Read all eight files under docs/. (c) Create out_data.txt: per the format specs.txt defined, with the value n = the number of non-empty lines in src/x.txt.
```

### 6. spec-early / spec-early-2
```
Work step by step. (a) Read specs.txt carefully - it defines how to write a summary file later - then delete specs.txt. (b) Read all eight files under docs/. (c) Following specs.txt exactly, create summary.txt from the numbers in src/y.txt.
```

### 7. long-fidelity / balloon-stress
```
Work step by step. (a) Read all eight files under docs/ (d01.txt through d08.txt) and create counts.txt with one line per file in filename order: `<filename>: <number of whitespace-separated words in that file>`. (b) Then read src/a.txt and src/b.txt and append two more lines in the same format: `src/a.txt: <count>` and `src/b.txt: <count>`.
```
