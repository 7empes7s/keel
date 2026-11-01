# Cloud sessions and CI rendered screenshots with different Chromium builds

On 2026-11-01 two threads (PRs #902 and #903) saw `visual · scuba-lists · 1440` fail in their cloud sessions
while the same test passed on master in CI. The repo pinned Playwright 1.56.1, which wants Chromium 141. Cloud
sessions cannot download that build, so they ran the pre-installed Chromium 153. The ScubaGear card sits on
fractional pixels, the two builds rounded its borders and text one pixel apart, and the diff passed the 1% limit.

| Mistake | Rule now |
| --- | --- |
| The repo's Playwright version differed from the one cloud sessions have installed, so CI and cloud used different browsers | Pin `@playwright/test` (and the `playwright-core` override) to the version cloud sessions have pre-installed (`npx playwright --version` with no project). When it changes, bump the pin and re-render only the screenshots that differ |
| A screenshot failing only in a cloud session was reported as a master failure | Check the latest master Portal run first; if it is green, compare browser versions before touching baselines |
