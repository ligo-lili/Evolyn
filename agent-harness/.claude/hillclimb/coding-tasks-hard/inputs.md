# coding-tasks-hard 评测输入集（baseline 候选）

- **流程**：与 coding-tasks 相同（`RunManager` + coding 工具集，沙箱 cwd，端到端跑），独立 flow 目录
  `.claude/hillclimb/coding-tasks-hard/`；跑法：`npm run eval:coding -- --flow .claude/hillclimb/coding-tasks-hard --sets evals/coding-hard-v1.json:hard --reps 6`。
- **判分**：纯确定性、看终态——fixture 跑自带 `npm test`（exit 0 = 过）；文件任务逐项检查最终文件内容（行数 / 精确行 / 排序 / 去重 / 正则）。判分前按模板还原 `test.js`+`package.json`（防绕过，与此前一致）；有还原时记入行 meta。
- **存在的理由**：现有 15 题对 deepseek-flash 已 98.9% 饱和、只能测回归；本集用更深的链、更狠的规模与两步修复链制造**质量余量**（实际掉分率以基线为准）。
- **来源**：以已测失败画像为依据的合成题集（多文件一致性 / 边界 / 迭代修复 / 规模×约束）。**Oracle 已于 2026-10-06 复验**：6/6 fixture 出厂必挂、按预期修复阶梯必过（其中 2 个 fixture 演示 fail→fail→pass 两步链）；7/7 文件任务参考解过判分、空输出必挂。
- **协议（同前）**：model = `deepseek/deepseek-flash`，reps = 6，auto-approve，无 skill 注入；评测基础设施（runner/判分器/任务集/fixture）由完整性闸门保护。

## 总表

| # | family (tags[0]) | id | 判分 | 起始 |
|---|------------------|----|------|------|
| 1 | deep-fix | deploy-config | `npm test`（4 文件链，config-key drift） | 模板重置 |
| 2 | deep-fix | pager | `npm test`（分页 off-by-one，边界页丢尾） | 模板重置 |
| 3 | deep-fix | gauge | `npm test`（clamp 参数互换，经 view 层显形） | 模板重置 |
| 4 | deep-fix | ledger | `npm test`（引用泄漏，经缓存报表显形） | 模板重置 |
| 5 | iterative-fix | checkout-cart | `npm test`（**两处缺陷**：乘数缺失 + 百分比错误） | 模板重置 |
| 6 | iterative-fix | table-summary | `npm test`（**两处缺陷**：空行 + 表头行） | 模板重置 |
| 7 | precision-scale | big-words | 40 行、A→Z、去重、行首非元音、全小写 | 无 |
| 8 | precision-scale | acronyms-24 | 24 行、全大写、A→Z、去重（含 BMW 类混合词元） | 无 |
| 9 | precision-scale | countries-25 | 25 行、Z→A、去重、不含字母 u | 无 |
| 10 | precision-scale | clean-34 | 34 行脏输入 → 精确 14 行（trim/去空/去重/排序） | 预置 `raw-lines.txt` |
| 11 | precision-scale | sections-merge | 三个源文件合并为三段结构、精确 24 行（各段去重/清洗/按段排序） | 预置 fruits.txt / veg.txt / grains.txt |
| 12 | transform-chain | totals-18 | 18 行订单 → 精确 15 行（qty≥4、乘积、降序、并列按名） | 预置 `orders.csv` |
| 13 | transform-chain | indexed-18 | 18 行词表 → 精确 13 行（大小写不敏感去重、小写、编号） | 预置 `words.txt` |

排序判分为 codepoint 序（大小写不敏感），与 `EVAL_JUDGE_VERSION=3` 一致。

## 逐题

### 1-4. deep-fix（fixture，预期修复各一行）
共同题干模板：`The project in repos/<id> has a failing test suite. Run `npm test` inside that directory, find the failing assertion, fix the SOURCE files (never test.js), and re-run `npm test` until it passes. Do not git commit.`

- **deploy-config**：`lib/plan.js` 读 `defaults.limits.batchSize`，而 `lib/defaults.js` 导出的是 `maxBatch`（两跳调用链 plan→summary→test 都有断言）。预期修复：改用 `maxBatch`。
- **pager**：`lib/pager.js` 的 `slice(start, start + size - 1)` 把每页最后一项丢掉（page 3 空页断言先炸）。预期修复：去掉 `- 1`。
- **gauge**：`lib/scale.js` 调 `clamp(max, reading, min)` 参数互换（经 `view.js` 渲染断言显形，越界钳位失效）。预期修复：改为 `clamp(reading, min, max)`。
- **ledger**：`lib/ledger.js` 的 `all()` 直接返回内部数组（引用泄漏——较早取得的列表在后续 `add` 后被改，报表快照断言炸）。预期修复：`return entries.slice()`。

### 5-6. iterative-fix（**题面明示"不止一处缺陷"**，难度在找全）
- **checkout-cart**：`pricing.js` 忘了乘 `qty`（`total=19≠58`）；修掉后 `discount.js` 的百分比没除 100（`applyDiscount(50,10)=-450`）才暴露。预期修复 2 处，各一行。
- **table-summary**：`parse.js` 不跳空行（count=6≠4 先炸）；修掉后表头行 `name,qty` 的 `NaN` 让 totalQty 爆（count=5 再炸）。预期修复 2 处：空行过滤 + 非有限 qty 过滤。

### 7. precision-scale / big-words
```
Create big-words.txt with exactly 40 lowercase English words, one per line, alphabetically sorted (A to Z), no duplicates, and none of the words may start with a vowel (a, e, i, o, u).
```

### 8. precision-scale / acronyms-24
```
Create acronyms.txt with exactly 24 technology acronyms or short names (e.g. API, BMW), one per line, in uppercase, alphabetically sorted (A to Z), no duplicates.
```
（BMW 类混合词元 = 已有的实测失败族：letter-by-letter 而非区域性排序。）

### 9. precision-scale / countries-25
```
Create countries-25.txt with exactly 25 country names, one per line, in REVERSE alphabetical order (Z to A), no duplicates, and none of the names may contain the letter 'u' (upper or lower case).
```

### 10. precision-scale / clean-34
```
The file raw-lines.txt contains a messy list. Create clean.txt: each distinct line of raw-lines.txt exactly once, with surrounding whitespace (spaces and tabs) removed, empty lines dropped, sorted alphabetically (A to Z), one per line and nothing else.
```

### 11. precision-scale / sections-merge
```
Three files each hold one name per line: fruits.txt, veg.txt, grains.txt. Create summary.txt containing, in order, one line per entry and nothing else: first the line FRUITS, then every distinct fruit from fruits.txt — surrounding whitespace (spaces and tabs) removed, blank lines dropped, each name kept exactly once — sorted alphabetically (A to Z); then the line VEGETABLES, then every distinct vegetable from veg.txt (same cleanup rules) sorted in REVERSE alphabetical order (Z to A); then the line GRAINS, then every distinct grain from grains.txt (same cleanup rules) sorted alphabetically (A to Z).
```
修正记录：初版（sections-21）是自由选词的题面却用 expectLinesExact 判分——基线抽查发现 0/6 全灭实为判分不公（模型产出满足题面）。已重构为输入决定型并重验（重算期望 == 集合期望；参考解过判、空输出挂），旧 6 行作废重跑。

### 12. transform-chain / totals-18
```
The file orders.csv holds lines of the form name,qty,price (prices are whole dollars). Create totals.txt containing, for each row whose qty is at least 4, one line: the name, a colon, a space, then that row's total cost (qty multiplied by price) as a plain integer, ordered by total cost from largest to smallest; break ties by name (A to Z).
```

### 13. transform-chain / indexed-18
```
The file words.txt holds one word per line, some repeated with different casing. Create indexed.txt with one line per DISTINCT word — two words are the same if they differ only in case, and the output form is lowercase — sorted alphabetically, each line formatted as the 1-based position, a period, a space, then the word (so the first line is `1. apple`).
```
