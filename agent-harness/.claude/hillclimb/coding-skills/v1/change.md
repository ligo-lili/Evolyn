# v1 — skill arm: fix-failing-node-test-suite injected

Skill A/B arm (not a code/prompt change): the promoted skill
`fix-failing-node-test-suite` (mined from read>edit>powershell, support 9) enters via
`--skill` as an `<available_skills>` pointer; the model reads the SKILL.md on
demand. Expected to matter on the deep-fix / iterative-fix fixture families.

Read: paired ≥ +2 net passes vs the no-skill baseline = helps; ≤ −2 = hurts.
