# v4 — second-model check: the winning prompt (v2) on deepseek/deepseek-v4-pro

Not a lever round — Step 5's second-model check before recommending v2's prompt
change. The artifact (`CODING_SYSTEM_PROMPT`) serves every model the harness runs;
v1 measured v4-pro under the OLD prompt (quality-rejected as a base: 129/135 = 95.6%,
out 384.9). This run measures the SAME model under the v2 prompt (the rule (4)
confirmation-round ban) — no adoption gates; informational.

Expectations (informational):
- quality: likely still ~95–96% (v4-pro's ordering-family weakness is orthogonal to
  the confirmation-round ban); below the flash adoption band by construction.
- out_tokens: v2's change removed rounds; v4-pro's file-task runs carried the same
  confirmation rounds under v1 (72 file runs) — expect the same lean-out direction,
  magnitude unknown.

Run: `npm run eval:coding -- --variant v4 --model deepseek/deepseek-v4-pro --reps 6`
