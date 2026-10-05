# coding-tasks 评测输入集（baseline 候选）

- **流程**：`harness run`（`RunManager`，与 CLI 同一条入口）在一次性沙箱里用 coding 工具集端到端完成任务；判分看**终态**，不看过程叙述。
- **判分**：纯确定性。修 bug 类跑 fixture 自带 `npm test`（exit 0 = 过，exit ≠0 = 挂，附输出尾部）；文件类逐项检查最终文件内容（行数 / 精确行 / 排序 / 去重 / 行正则）。无 LLM judge。
- **防绕过**：判分前会把 fixture 的 `test.js` + `package.json` 按模板还原（agent 改测试文件不能让判分恒绿）；有还原动作时记入该行 meta。
- **指标**：headline = pass rate（每题 0/1）；过程指标 = write→read-back（仓库既有 `readBackVerified`）；perf 列 = latency_s、tool_calls、usage tokens（deepseek 上报零成本 → 美元列暂缺，以 token 计）。
- **基线协议（暂定）**：model = `deepseek/deepseek-flash`，toolset = `coding`，reps = 2，auto-approve（评测设计如此），无 skill 注入，沙箱 cwd。
- **来源**：本仓库 `evals/coding-fix-v1.json` + `evals/file-creation.json` + `evals/file-precision-v1.json`（人工编写）。可解性于 2026-10-05 复核：三套 fixture 出厂必挂、按预期一行修复后必过；12 道文件类任务判分器 oracle 12/12 通过、空输出 12/12 失败。
- **附带证据（各集自身的既有记录）**：file-creation 在 deepseek-flash 上曾 18/18 全过（连 read-back 行为也 18/18）——对该模型零区分度，保留以获得全貌、迭代时可裁剪；file-precision 在 qwen-turbo 上有失败密度（3/12）；coding-fix-v1 从未真实跑过（本次基线补上这个未知数）。

## 总表

| # | tags[0] | id | 判分（终态） | 起始状态 |
|---|---------|----|--------------|----------|
| 1 | bug-fix | string-utils | `npm test`（cwd=repos/string-utils）exit 0 | `repos/string-utils` 从模板重置 |
| 2 | bug-fix | inventory-cli | `npm test`（cwd=repos/inventory-cli）exit 0 | `repos/inventory-cli` 从模板重置 |
| 3 | bug-fix | todo-store | `npm test`（cwd=repos/todo-store）exit 0 | `repos/todo-store` 从模板重置 |
| 4 | file-creation | sorted-list | 恰 8 行、A→Z、去重 | 无 |
| 5 | file-creation | exact-format | 恰 10 行、逐行 `item-1`…`item-10` | 无 |
| 6 | file-creation | update-existing | 恰 7 行精确：flour…oil | 预置 `pantry.txt`（4 行） |
| 7 | file-creation | precision-format | 全文件 = 单行 `version: 1.0.0` | 无 |
| 8 | file-creation | ordered-domain-list | 8 行精确：水星…海王星（英文、首字母大写） | 无 |
| 9 | file-creation | arith-transform | 14 行精确（按序 ×7） | 预置 `mult-source.txt`（14 个数） |
| 10 | file-precision | descending-months | 恰 12 行、Z→A、去重 | 无 |
| 11 | file-precision | vowel-exclusion | 恰 10 行、A→Z、去重、行首非元音 | 无 |
| 12 | file-precision | brands-20 | 恰 20 行、A→Z、去重 | 无 |
| 13 | file-precision | langs-compound | 恰 14 行、Z→A、去重、不含 q/Q | 无 |
| 14 | file-precision | trees-30 | 恰 30 行、A→Z、去重 | 无 |
| 15 | file-precision | repair-control | 恰 7 行精确（去重 + 排序后） | 预置 `pantry-fix.txt`（8 行、含重复乱序） |

排序判分为 codepoint 序（大小写不敏感），与判分器 `EVAL_JUDGE_VERSION=3` 语义一致。

## 逐题

### 1. bug-fix / string-utils
```
The project in repos/string-utils has a failing test suite. Run `npm test` inside that directory, find the failing assertion, fix the SOURCE files (never test.js), and re-run `npm test` until it passes. Do not git commit.
```
模板 `evals/fixtures/string-utils`（多文件：`index.js` 转发了 legacy v1 parser，v2 parser 就在旁边）。预期修复：`index.js` 改回 `./lib/parse`（一行）。备注：直接改 `parse-v1.js` 的字段序也会让测试绿——判据就是"测试绿"，接受。

### 2. bug-fix / inventory-cli
```
The project in repos/inventory-cli has a failing test suite. Run `npm test` inside that directory, find the failing assertion, fix the SOURCE files (never test.js), and re-run `npm test` until it passes. Do not git commit.
```
模板 `evals/fixtures/inventory-cli`（config-key drift：`service.js` 读 `config.threshold`，`config.js` 里叫 `lowStockThreshold`）。预期修复：改用既有 key（一行）。

### 3. bug-fix / todo-store
```
The project in repos/todo-store has a failing test suite. Run `npm test` inside that directory, find the failing assertion, fix the SOURCE files (never the test file), and re-run `npm test` until it passes. Do not git commit.
```
模板 `evals/fixtures/todo-store`（serializer/store 漂移：`save()` 写数字 `1`，`load()` 按字符串 `"1"` 解）。预期修复：`load()` 改走 `serializer.fromJSON`（一行 + 一 import）。

### 4. file-creation / sorted-list
```
Create a file sorted-list.txt with exactly 8 tree names, one per line, alphabetically sorted (A to Z), no duplicates.
```

### 5. file-creation / exact-format
```
Create a file checklist.txt containing exactly 10 lines. Line k must be exactly item-k in lowercase with no spaces (so the first line is item-1 and the last line is item-10).
```

### 6. file-creation / update-existing
```
The file pantry.txt already lists some staples. Make pantry.txt contain exactly these 7 items, one per line, in this order: flour, sugar, rice, beans, salt, pepper, oil.
```

### 7. file-creation / precision-format
```
Create a file version.txt whose entire content is exactly one line: version: 1.0.0
```

### 8. file-creation / ordered-domain-list
```
Create a file planets.txt listing the 8 planets of the solar system, one per line, ordered from closest to the sun to farthest, each name capitalized (e.g. Mercury).
```

### 9. file-creation / arith-transform
```
The file mult-source.txt contains 14 numbers, one per line. Create a file mult-doubled7.txt containing each of those numbers multiplied by 7, in the same order, one per line.
```

### 10. file-precision / descending-months
```
Create a file months-desc.txt with exactly 12 month names (January through December), one per line, in REVERSE alphabetical order (Z to A), no duplicates.
```

### 11. file-precision / vowel-exclusion
```
Create a file animals-cons.txt with exactly 10 animal names, one per line, alphabetically sorted (A to Z), no duplicates — but EXCLUDE any animal whose English name starts with a vowel (a, e, i, o, u).
```

### 12. file-precision / brands-20
```
Create a file brands-20.txt with exactly 20 car brand names, one per line, alphabetically sorted (A to Z), no duplicates.
```

### 13. file-precision / langs-compound
```
Create a file langs-desc.txt with exactly 14 programming language names, one per line, in REVERSE alphabetical order (Z to A), no duplicates, and none of the names may contain the letter q (upper or lower case).
```

### 14. file-precision / trees-30
```
Create a file trees-30.txt with exactly 30 tree species names, one per line, alphabetically sorted (A to Z), no duplicates.
```

### 15. file-precision / repair-control
```
The file pantry-fix.txt has problems: it contains duplicate lines and the lines are not alphabetically sorted. Fix it: remove duplicates (keep each distinct item exactly once), sort the lines A to Z, and do not add or remove any distinct items.
```
