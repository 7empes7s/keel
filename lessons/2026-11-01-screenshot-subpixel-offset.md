# A section screenshot moved with the sub-pixel rounding of the text above it

On 2026-11-01 two threads (PRs #902 and #903) saw `visual · scuba-lists · 1440` fail in cloud sessions while it
passed on master in CI. The first guess was the browser: the repo pinned Playwright 1.56.1 (Chromium 141), which
cloud sessions cannot download, so they ran Chromium 153. Pinning Playwright 1.63.0 gave both places Chromium 153,
but CI still rendered the old images: the browser was not the cause.

The ScubaGear card sits about 1,020 px down, below text blocks whose heights are fractions of a pixel. Those
fractions differ slightly between machines, so the card started at y = …0.72 in the cloud and about …0.47 in CI,
and its borders rounded to different rows (2% of pixels, over the 1% limit).

| Mistake | Rule now |
| --- | --- |
| A screenshot of a section far down a page depended on the rounding of everything above it | Before screenshotting such a section, move it to a whole pixel (`snapToWholePixel` in `ui.spec.ts`), and check the image stays identical when the content above shifts by a fraction |
| Baselines were re-rendered for a guessed cause before CI confirmed it | Confirm the cause against CI's output (same diff count, same rows) before replacing CI-rendered baselines |
| Cloud sessions could not run the pinned Playwright's browser | Keep `@playwright/test` and the `playwright-core` override on the version cloud sessions have pre-installed (`npx playwright --version` outside the project) |
