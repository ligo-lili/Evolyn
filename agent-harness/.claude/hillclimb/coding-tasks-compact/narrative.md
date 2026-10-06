# coding-tasks-compact baseline — narrative

Environment fingerprint: harness_sha `efe455681461…` (runner + coding-compact-v1.json +
grader sources; recorded at the re-run) · model `deepseek/deepseek-flash` ·
node v24.14.0.

Purpose: measure the fidelity cost of the harness's two-layer context management under
an adversarial probe set — long tasks whose correct end state depends on information
that leaves the re-derivable workspace. **Attribution design:** `baseline` = compact arm
(preferenceTokens 10240, test-scaled; compaction fires), `v1` = control arm
(preferenceTokens 1,000,000; never fires). A task failing in compact but passing in
control is compaction damage; both-fail is capability; both-pass means no damage.

| arm | preferenceTokens | pass | in toks | out toks | tools | s/run |
|-----|------------------|------|---------|----------|-------|-------|
| baseline (compact) | 10 240 | 20/21 | 11 663 | 1 329 | 15 | 10 |
| v1 (control) | 1 000 000 | 20/21 | 10 140 | 1 451 | 14 | 10 |

## Attribution (7 tasks × 3 reps per arm)

| task | class | compact | control | read |
|------|-------|---------|---------|------|
| recall-token | mandatory-recall | 3/3 | 3/3 | held (seed overwritten — not re-derivable) |
| recall-tag | mandatory-recall | 3/3 | 3/3 | held (cfg deleted) |
| fix-factor | mandatory-recall | 3/3 | 3/3 | held (computed total, file deleted) |
| spec-early-1 | spec-early | **2/3** | 3/3 | **compaction damage (1/21)** — `out_data.txt` missing in one run |
| spec-early-2 | spec-early | 3/3 | 3/3 | held |
| balloon-stress | long-fidelity | 3/3 | 3/3 | held |
| amend-rename | long-fidelity | 3/3 | 2/3 | one control-side execution slip (mixed-case name) — noise-level, not damage |

**Findings:** at this operating point (≈12.9k-token balloon, 10k threshold) the
two-layer management is nearly lossless for this model — 9/9 mandatory-recall runs
held; exactly one damage event in 21 compact runs. The visible cost is a **fidelity
tax**: compact arm **+15% input tokens** (recovery re-reading after folds), out −8%,
tool_calls +3%, latency ≈ 0. Mechanism separation was verified directly in the pilot's
harness traces: compact arm 2×compact + 3×defer + 6×reuse vs control 7×reuse.

**Correction record (pre-freeze):** amend-rename's first spec read `k_v2.txt
(uppercase key…)` — the model consistently produced lowercase filenames, a defensible
reading; the spec was made explicit (`<UPPERCASE KEY>_v2.txt`, with an example) and the
task re-run in both arms. The one remaining fixed-set control failure (`ALPHA_v2.txt`)
is a model execution slip — reported, not silently forgiven.

**What I'd try next:** scale the probe (bigger balloon / deeper folds / lower
threshold) to locate where losses begin; add a mid-run needle that must be *used*
(not only echoed). Standing discipline: re-run this suite after any change to
`src/context/**` — it is the regression instrument for compaction specifically (the
context policy is deliberately NOT in `harness_paths`: it is the subject under test
for this flow, not protected machinery).
