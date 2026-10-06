# coding-skills — skill self-evolution A/B (narrative)

Environment fingerprint: harness_sha `e6ef2bec53a5` (runner + coding-hard-v1.json +
the three promoted SKILL.md files + grader sources) · model `deepseek/deepseek-flash`
· node v24.14.0.

**Question:** does the self-evolution loop deliver? The mine → distill → promote
pipeline demonstrably works (patterns with support up to 264 in the dev ledger; three
promoted skills). What was never measured is the loop's end claim: **injecting a
promoted skill improves outcomes.** The old A/B found no discrimination on a saturated
battery; this run puts the promoted library on `coding-hard-v1` — the failure-mass
battery (96.2%, third-party verified) whose families topically match the skills.

Arms (each 13 tasks × 6 reps, identical protocol; ownership of the arm differs only
in `--skill`):

| arm | variant | skill | mined pattern | support |
|-----|---------|-------|---------------|---------|
| control | baseline | none | — | — |
| 1 | v1 | fix-failing-node-test-suite | read>edit>powershell | 9 |
| 2 | v2 | powershell-test-fix-loop | read>edit>powershell | 19 |
| 3 | v3 | write-then-readback-verify | write_file>read_file | 152 |

## Pre-registered reads (before the run)

- **Helps** = paired vs baseline: ≥ +2 net passes converted. **Hurts** = ≤ −2.
  Within ±1 = no measurable effect (report as such; the pointer/distraction cost is
  visible in perf columns either way).
- **Mechanism/engagement**: the arm's traces must show the model READING the
  SKILL.md (read tool call on the skill path). A skill that is injected but never
  read is a pointer-retrieval finding, recorded separately.
- **Family split**: the two repair skills are expected to matter on
  deep-fix/iterative-fix (6 fixture tasks); write-then-readback-verify on the file
  tasks. The report's tag sections carry this split.
- **Cost**: token/latency columns per arm (skill reading costs tokens; a "win" that
  doubles cost is still reported as such).

Injection mechanics (verified in the smoke): the runner seeds each sandbox with the
promoted skill files and rebuilds the in-sandbox skill index, so `skills.only`
resolves and the rendered <available_skills> paths live inside the model's workspace
(smoke trace contains the block + the skill name).

## Results (2026-10-06)

| arm | skill | pass | paired net vs baseline | in toks | out toks | tools | s/run |
|-----|-------|------|------------------------|---------|----------|-------|-------|
| baseline | none | **78/78** | — | 1136 | 693 | 5.9 | 7.0 |
| v1 | fix-failing-node-test-suite | 77/78 | −1 (no measurable effect) | 1897 | 743 | 6.3 | 7.4 |
| v2 | powershell-test-fix-loop | 77/78 | −1 (no measurable effect) | 1796 | 716 | 6.4 | 7.3 |
| v3 | write-then-readback-verify | 76/78 | −2 (registered "hurts" — see flake band) | 1934 | 892 | 6.7 | 8.2 |

**Ceiling + flake reality:** the no-skill baseline drew a perfect 78/78 — while the
hard flow's own baseline (same set, same runner, same day) drew 75/78. The set's own
reproducibility is ≈ ±4%: 3–4 precision-family slips per 78 runs. **Every arm delta
(−1, −1, −2) sits inside that band and consists solely of the same precision-slip
family** (countries-25 ×4, big-words ×1 across arms) — none is attributable to the
skill. Conclusion: **no skill shows a measurable benefit — and at a 100% baseline
none could have.** The only reproducible effect of injection is cost: **+60–70%
input tokens** (1136 → 1797–1934) for a pointer the model consults partially.

**Engagement (real and partial):** injection present in 78/78 rows of every arm
(system-prompt block); runs whose tool args reference the skill path: v1 32/78,
v2 25/78, v3 22/78 (~28–41%). The library is being consulted; it just doesn't pay.
The v1-vs-v2 alternate-distillation comparison (same mined pattern) carries no
signal at this n either.

**Verdict on the loop's end claim:** mine → distill → promote demonstrably runs
(patterns with support up to 264; three promoted skills; injection machinery
verified end-to-end incl. the sandbox seeding). But "a promoted skill improves
outcomes" remains **unsupported** for this model on this battery — consistent with
the earlier saturated-battery finding, now confirmed on a failure-mass set: flash's
residual precision flake (~4%) is too thin and too random to attribute, and at a
100% draw there is nothing to convert. A fair test needs a floor where the model
actually fails repeatedly — a weaker eval model (e.g. qwen-turbo's 3/12 baseline on
file-precision; needs a DASHSCOPE key) or tasks beyond current capability.
