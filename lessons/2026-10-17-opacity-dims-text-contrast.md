# Dimming a row with opacity broke text contrast, and the test only caught it sometimes

On 2026-10-17 `a11y · job-restore-completion · light` failed at random on master. Verified follow-ups
were dimmed with `opacity: 0.85`, which took the evidence line (`--text-soft` on `--surface-muted`)
down to 3.88:1, below the 4.5:1 AA minimum. axe reports contrast only when it can work out the
background; when it cannot (it saw the shell's rail gradient behind the text), the node goes to
"incomplete", not "violation". Run alone the test passed; under parallel load it failed 38 of 40 runs.

| Mistake | Rule now |
| --- | --- |
| Dimming text with `opacity` on a parent | Never lower text contrast with opacity; pick a token colour that still passes AA |
| Calling a red a11y check a flake | Reproduce with `--repeat-each=40 --workers=8`; a contrast failure that shows at all is a real failure |
| One-worker reruns as proof of a fix | Prove a fix with the same stress run (`80 passed` here) |
