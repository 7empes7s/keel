# Screenshot baselines differed by machine, and a debug step merged with the fix

On 2026-10-16 the switch to IBM Plex (PR #357) passed every screenshot test in a cloud session and failed six on CI.
CI hinted Plex to whole-pixel advances and the cloud session did not, so some lines wrapped or sat a pixel apart.
The fix was `--font-render-hinting=none` in `portal/ui-harness/playwright.config.ts`. While diagnosing it, a
temporary CI step and probe scripts were pushed to the same PR, and the Merge gate merged them once CI went green.

| Mistake | Rule now |
| --- | --- |
| Screenshot baselines rendered with machine-dependent font hinting | The harness launches Chromium with unhinted fonts; keep that flag when changing fonts or the config |
| Temporary diagnostics pushed to a PR that carries the `automerge` label | Remove the `automerge` label before pushing debug commits, or put diagnostics on a separate branch |
