# Headroom probes (2026-09-27)

Baseline failure-rate probes for eval-task design (deepseek/deepseek-flash, no skills):

- probe-hard.json — 12-color exact order / 15-country sorted / 15 Fibonacci: 6/6 baseline pass
- probe-hard2.json — 12-month REVERSE alphabetical / vowel-excluded 10 animals / 20-brand sorted: 6/6 pass
- probe-hard3.json — repair-without-restating fixture / 14-language compound constraints / 30-tree sorted: 6/6 pass
- probe-mult.json — 14-number x7 arithmetic transform from fixture: 3/3 pass

Conclusion: 24/24 — the baseline sits at the pass-rate ceiling on single-shot file tasks.

The formal 36-run eval on file-creation-v1 then added the second finding: the baseline
also self-verifies (read-back after write) 18/18 — the write-verify skill has no
adoption headroom either. For this model+domain the skill is redundant at ~+18%
tokens/run (SKILL.md read).

Skill gating therefore needs a domain/model with failure mass:
- a weaker/cheaper eval model (e.g. qwen-flash via DashScope) — skill as
  ring weak models up to strong-model behavior\;
- multi-file consistency and long-horizon tasks (needs multi-file judging);
- error-handling regimes (missing inputs, permission denials, compaction).
