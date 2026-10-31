// Styles for the Baselines section: Approved setup, Changes, Compare and the guided
// create. Tokens are the only colour source (app/globals.css); spacing uses the 4 px
// scale, radii the 8 / 12 pair. Rendered once per page; React hoists and de-duplicates it.
const CSS = `
.bl-page { display: grid; gap: var(--space-lg); min-width: 0; }
.bl-section { display: grid; gap: var(--space-md); min-width: 0; }
.bl-page + .bl-section { margin-top: var(--space-xl); }
.bl-section-head { display: flex; flex-wrap: wrap; align-items: end; justify-content: space-between; gap: var(--space-xs) var(--space-md); }
.bl-section-head h2 { margin: 0; font-size: 1.125rem; font-weight: 650; }
.bl-section-head p { margin: var(--space-2xs) 0 0; color: var(--text-soft); font-size: 0.875rem; }
.bl-help { margin: 0; color: var(--text-soft); font-size: 0.8125rem; line-height: 1.45; }

.bl-card { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); }
.bl-link { color: inherit; text-decoration: none; transition: border-color var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out); }
.bl-link:hover { border-color: var(--line-strong); background: var(--surface-raised); }
.bl-link:active { transform: translateY(1px); }
.bl-link:focus-visible, .bl-row-link:focus-visible, .bl-inline-link:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.bl-inline-link { margin-left: var(--space-xs); color: var(--text); font-weight: 600; text-decoration: underline; text-underline-offset: 0.2em; border-radius: 2px; }
.bl-page .section-kicker, .bl-sheet .section-kicker, .bl-section .section-kicker { color: var(--text-soft); }
.bl-sheet .diff-kind, .bl-sheet .diff-changed .diff-kind, .bl-sheet .diff-added .diff-kind, .bl-sheet .diff-removed .diff-kind { color: var(--text-soft); }
.bl-sheet:focus { outline: none; }
.bl-sheet .drift-diff-head h3 { font-family: var(--font-sans); }
.bl-wizard .segmented { display: inline-flex; width: auto; max-width: 100%; justify-self: start; }
.bl-inline-link:hover { text-decoration-thickness: 2px; }

.bl-kind-icon { display: inline-grid; width: 2.25rem; height: 2.25rem; flex: none; place-items: center; border-radius: var(--radius-md); background: var(--neutral-bg); color: var(--text-soft); }
.bl-kind-icon[data-tone="urgent"] { background: var(--urgent-bg); color: var(--urgent); }
.bl-kind-icon[data-tone="soon"] { background: var(--check-soon-bg); color: var(--check-soon); }
.bl-kind-icon[data-tone="low"] { background: var(--low-risk-bg); color: var(--low-risk); }
.bl-kind-icon[data-tone="fine"] { background: var(--fine-bg); color: var(--fine); }

.bl-chip { display: inline-flex; min-height: 1.5rem; padding: 0 var(--space-xs); align-items: center; gap: 0.3rem; border-radius: var(--radius-pill); background: var(--neutral-bg); color: var(--text-soft); font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
.bl-chip .icon { width: 0.875rem; height: 0.875rem; }
.bl-chip[data-tone="urgent"] { background: var(--urgent-bg); color: var(--urgent); }
.bl-chip[data-tone="soon"] { background: var(--check-soon-bg); color: var(--check-soon); }
.bl-chip[data-tone="low"] { background: var(--low-risk-bg); color: var(--low-risk); }
.bl-chip[data-tone="fine"] { background: var(--fine-bg); color: var(--fine); }

/* Approved setup in use */
.bl-current { display: grid; gap: var(--space-md); padding: var(--space-lg); }
.bl-current-head { display: flex; align-items: flex-start; gap: var(--space-md); }
.bl-current-head .bl-kind-icon { width: 2.75rem; height: 2.75rem; }
.bl-current-name { min-width: 0; flex: 1; }
.bl-current-name h2 { margin: 0; font-size: 1.25rem; font-weight: 650; overflow-wrap: anywhere; }
.bl-current-name p { margin: var(--space-2xs) 0 0; color: var(--text-soft); }
.bl-facts { display: grid; margin: 0; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-muted); }
.bl-fact { display: grid; align-content: start; gap: var(--space-2xs); padding: var(--space-sm) var(--space-md); min-width: 0; }
.bl-fact + .bl-fact { border-left: 1px solid var(--line); }
.bl-fact dt { color: var(--text-soft); font-size: 0.75rem; font-weight: 600; }
.bl-fact dd { display: grid; gap: var(--space-2xs); margin: 0; font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
.bl-fact dd small { color: var(--text-soft); font-size: 0.8125rem; font-weight: 400; line-height: 1.4; }
.bl-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
.bl-actions .activate-control { display: contents; }
.bl-empty { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-md); padding: var(--space-lg); }
.bl-empty > div { min-width: 0; flex: 1 1 18rem; }
.bl-empty h2, .bl-empty h3 { margin: 0; font-size: 1.0625rem; }
.bl-empty p { margin: var(--space-2xs) 0 0; color: var(--text-soft); }

/* By service */
.bl-services { display: grid; margin: 0; padding: 0; list-style: none; gap: var(--space-md); grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
.bl-services > li { display: grid; }
.bl-service { display: grid; align-content: start; gap: var(--space-sm); padding: var(--space-md); border-top-width: 3px; }
.bl-service[data-tone="urgent"] { border-top-color: var(--urgent); }
.bl-service[data-tone="soon"] { border-top-color: var(--check-soon); }
.bl-service[data-tone="low"] { border-top-color: var(--low-risk); }
.bl-service[data-tone="fine"] { border-top-color: var(--fine); }
.bl-service-head { display: flex; align-items: center; gap: var(--space-sm); }
.bl-service-head > .icon { color: var(--text-soft); }
.bl-service-head > .score-ring { margin-left: auto; }
.bl-score { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-md) var(--space-lg); padding: var(--space-md) var(--space-lg); border-left-width: 4px; }
.bl-score[data-tone="fine"] { border-left-color: var(--fine); }
.bl-score[data-tone="soon"] { border-left-color: var(--check-soon); }
.bl-score[data-tone="urgent"] { border-left-color: var(--urgent); }
.bl-score-words { display: grid; flex: 1 1 16rem; gap: var(--space-2xs); min-width: 0; }
.bl-score-words h3 { margin: 0; font-size: 1.125rem; font-weight: 650; }
.bl-score-words p { margin: 0; }
.bl-service-name { display: grid; min-width: 0; line-height: 1.3; }
.bl-service-name b { font-weight: 650; }
.bl-service-name small { overflow: hidden; color: var(--text-soft); font-size: 0.8125rem; text-overflow: ellipsis; white-space: nowrap; }
.bl-bar { display: flex; height: 0.5rem; overflow: hidden; gap: 2px; border-radius: var(--radius-pill); background: var(--surface-muted); }
.bl-bar > span { min-width: 0; flex-basis: 0; }
.bl-bar > span[data-part="in-line"] { background: var(--fine); }
.bl-bar > span[data-part="not-covered"] { background: var(--neutral-bg); }
.bl-bar > span[data-part="changed"] { background: var(--low-risk); }
.bl-bar > span[data-part="changed"][data-tone="urgent"] { background: var(--urgent); }
.bl-bar > span[data-part="changed"][data-tone="soon"] { background: var(--check-soon); }
.bl-service-stats { display: grid; margin: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-xs); }
.bl-service-stats > div { display: grid; gap: 0.125rem; }
.bl-service-stats dt { color: var(--text-soft); font-size: 0.75rem; font-weight: 600; }
.bl-service-stats dd { margin: 0; font-size: 1.375rem; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; }
.bl-service-stats dd small { margin-left: 0.25rem; color: var(--text-soft); font-size: 0.75rem; font-weight: 500; }
.bl-service-stats [data-part="changed"][data-tone="urgent"] dd { color: var(--urgent); }
.bl-service-stats [data-part="changed"][data-tone="soon"] dd { color: var(--check-soon); }
.bl-service-stats [data-part="changed"][data-tone="low"] dd { color: var(--low-risk); }
.bl-service-note { margin: 0; padding-top: var(--space-sm); border-top: 1px solid var(--line); color: var(--text-soft); font-size: 0.8125rem; line-height: 1.45; }
.bl-go { display: inline-flex; margin-left: var(--space-xs); align-items: center; color: var(--text); text-decoration: underline; text-underline-offset: 0.2em; font-weight: 600; white-space: nowrap; }
.bl-go .icon { width: 1rem; height: 1rem; transition: transform var(--duration-fast) var(--ease-out); }
.bl-link:hover .bl-go .icon { transform: translateX(2px); }
.bl-actions .btn-sm { min-height: 2.5rem; padding: 0 var(--space-md); font-size: 0.8125rem; }
.bl-job { display: flex; align-items: center; gap: var(--space-md); padding: var(--space-sm) var(--space-md); }
.bl-job-name { display: grid; flex: 1; min-width: 0; line-height: 1.35; }
.bl-job-name small { color: var(--text-soft); font-size: 0.8125rem; }
.bl-legend { display: flex; flex-wrap: wrap; margin: 0; gap: var(--space-xs) var(--space-lg); color: var(--text-soft); font-size: 0.8125rem; }
.bl-legend > div { display: flex; align-items: baseline; gap: var(--space-xs); max-width: 26rem; }
.bl-legend dt { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--text); font-weight: 600; white-space: nowrap; }
.bl-legend dt::before { width: 0.625rem; height: 0.625rem; border-radius: 2px; content: ""; }
.bl-legend dt[data-part="changed"]::before { background: linear-gradient(90deg, var(--urgent) 0 33%, var(--check-soon) 33% 66%, var(--low-risk) 66%); }
.bl-legend dt[data-part="in-line"]::before { background: var(--fine); }
.bl-legend dt[data-part="not-covered"]::before { background: var(--neutral-bg); box-shadow: inset 0 0 0 1px var(--line-strong); }
.bl-legend dd { margin: 0; }

/* Other versions */
.bl-versions { display: grid; margin: 0; padding: 0; list-style: none; gap: var(--space-sm); }
.bl-version { display: grid; align-items: center; gap: var(--space-sm) var(--space-md); padding: var(--space-sm) var(--space-md); grid-template-columns: 2.25rem minmax(0, 1.2fr) minmax(0, 1fr) 12rem 8rem; grid-template-areas: "icon name when chip actions"; }
.bl-version > .bl-kind-icon { grid-area: icon; }
.bl-version-name { grid-area: name; }
.bl-version-when { grid-area: when; }
.bl-version > .bl-chip { grid-area: chip; justify-self: end; }
.bl-version-actions { grid-area: actions; }
.bl-version-name, .bl-version-when { display: grid; min-width: 0; line-height: 1.35; }
.bl-version-name b { font-weight: 600; overflow-wrap: anywhere; }
.bl-version-name small, .bl-version-when small { color: var(--text-soft); font-size: 0.8125rem; }
.bl-version-when time { font-size: 0.875rem; }
.bl-version-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-xs); }
.bl-version-actions .activate-control { display: grid; gap: var(--space-2xs); }

/* Changes: tiles, context and rows */
.bl-tiles { display: grid; margin: 0; gap: var(--space-sm); grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); }
.bl-tile { display: grid; align-content: start; gap: var(--space-2xs); padding: var(--space-sm) var(--space-md); border-left-width: 3px; }
.bl-tile[data-tone="urgent"] { border-left-color: var(--urgent); }
.bl-tile[data-tone="soon"] { border-left-color: var(--check-soon); }
.bl-tile[data-tone="low"] { border-left-color: var(--low-risk); }
.bl-tile[data-tone="fine"] { border-left-color: var(--fine); }
.bl-tile[aria-current] { border-color: var(--text-soft); box-shadow: inset 0 0 0 1px var(--text-soft); background: var(--surface-raised); }
.bl-tile-label { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--text-soft); font-size: 0.8125rem; font-weight: 600; }
.bl-tile-label .icon { width: 1rem; height: 1rem; }
.bl-tile[data-tone="urgent"] .bl-tile-label .icon { color: var(--urgent); }
.bl-tile[data-tone="soon"] .bl-tile-label .icon { color: var(--check-soon); }
.bl-tile[data-tone="low"] .bl-tile-label .icon { color: var(--low-risk); }
.bl-tile[data-tone="fine"] .bl-tile-label .icon { color: var(--fine); }
.bl-tile .bl-tile-check { width: 1rem; height: 1rem; margin-left: auto; color: var(--accent); }
.bl-tile .bl-tile-adds { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }
.bl-tile[aria-current] .bl-tile-label { color: var(--text); }
.bl-tile-count { font-size: 1.75rem; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; }
.bl-tile small, .bl-tile dd small { color: var(--text-soft); font-size: 0.8125rem; }
.bl-tile dd { display: grid; gap: var(--space-2xs); margin: 0; }
.bl-tile dd .bl-inline-link { margin: 0; justify-self: start; font-size: 0.8125rem; }
.bl-context { display: grid; gap: var(--space-2xs); }
.bl-context p, .bl-filter-note { display: flex; align-items: flex-start; margin: 0; gap: var(--space-xs); color: var(--text-soft); font-size: 0.875rem; line-height: 1.45; }
.bl-context .icon { width: 1rem; height: 1rem; margin-top: 0.15rem; flex: none; }
.bl-context a { color: var(--text); font-weight: 600; text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 0.2em; }
.bl-context a:hover { text-decoration-color: currentColor; }
.bl-filter-note { flex-wrap: wrap; align-items: baseline; padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-md); background: var(--surface-muted); color: var(--text); }
.bl-row { display: flex; align-items: center; gap: var(--space-md); min-width: 0; }
.bl-row-name { display: grid; flex: 1; min-width: 0; line-height: 1.3; }
.bl-row-link { justify-self: start; border-radius: 2px; color: var(--text); font-weight: 600; text-decoration: none; overflow-wrap: anywhere; }
.bl-row-link:hover { color: var(--text); text-decoration: underline; text-underline-offset: 0.2em; }
.bl-row-name small { color: var(--text-soft); font-size: 0.8125rem; }
.bl-row-who { display: grid; min-width: 8.5rem; font-size: 0.875rem; line-height: 1.3; text-align: right; }
.bl-row-who small { color: var(--text-soft); font-size: 0.8125rem; }

/* Details panel and decision sheet */
.bl-sheet-root { position: fixed; z-index: 70; inset: 0; }
.bl-sheet-scrim { position: absolute; inset: 0; background: var(--scrim); animation: fade-in var(--duration-base) var(--ease-out) both; }
.bl-sheet { position: absolute; top: 0; right: 0; bottom: 0; display: flex; width: min(30rem, 100%); flex-direction: column; border-left: 1px solid var(--line-strong); background: var(--surface); box-shadow: var(--shadow-overlay); animation: bl-panel-in var(--duration-slow) var(--ease-spring) both; }
.bl-sheet[data-wide] { width: min(42rem, 100%); }
@keyframes bl-panel-in { from { transform: translateX(2.5rem); opacity: 0; } to { transform: none; opacity: 1; } }
.bl-sheet-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-md); padding: var(--space-md) var(--space-lg); border-bottom: 1px solid var(--line); }
.bl-sheet-head > div:first-child { flex: 1; min-width: 0; }
.bl-sheet-step { display: inline-flex; flex: none; align-items: center; gap: var(--space-2xs, 0.25rem); color: var(--text-soft); font-size: 0.8125rem; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.bl-sheet-step .icon-button:first-child svg { transform: scaleX(-1); }
.bl-sheet-step .icon-button:disabled { opacity: 0.4; cursor: default; }
.bl-sheet-head h2 { margin: var(--space-2xs) 0 0; font-size: 1.25rem; font-weight: 650; overflow-wrap: anywhere; }
.bl-sheet-kicker { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); color: var(--text-soft); font-size: 0.8125rem; }
.bl-sheet-body { display: grid; flex: 1; align-content: start; gap: var(--space-md); padding: var(--space-md) var(--space-lg) var(--space-lg); overflow-y: auto; overscroll-behavior: contain; }
.bl-sheet-body .drift-diff, .bl-sheet-body .decision-evidence, .bl-sheet-body .change-attribution { margin: 0; }
.bl-sheet-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); padding: var(--space-sm) var(--space-lg) calc(var(--space-sm) + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: var(--surface-muted); }
.bl-sheet-foot .bl-help { flex-basis: 100%; }
.bl-cannot { display: flex; flex-basis: 100%; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin: 0; padding: var(--space-xs) var(--space-sm); border-left: 3px solid var(--check-soon); border-radius: var(--radius-md); background: var(--check-soon-bg); font-size: 0.8125rem; line-height: 1.45; }
.bl-why { display: grid; gap: var(--space-xs); padding: var(--space-sm) var(--space-md); border-radius: var(--radius-md); background: var(--surface-muted); }
.bl-why h3 { margin: 0; font-size: 0.875rem; }
.bl-why p { margin: 0; }
.bl-glance { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-xs); margin: 0; }
.bl-glance-fact { display: grid; gap: 0.2rem; align-content: start; min-width: 0; padding: var(--space-sm); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); }
.bl-glance-fact[data-fact="what"] { grid-column: 1 / -1; border-left: 4px solid var(--accent); }
.bl-glance-fact dt { color: var(--text-soft); font-size: 0.75rem; font-weight: 700; }
.bl-glance-fact dd { display: grid; gap: 0.15rem; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.bl-glance-fact dd small { color: var(--text-soft); font-weight: 400; font-size: 0.8125rem; }
.bl-glance-fact:not([data-fact]):not([data-known]):last-child dd { color: var(--text-soft); }
.bl-how { display: grid; gap: 0.25rem; margin: 0; padding-left: 1.1rem; }
@media (max-width: 640px) { .bl-glance { grid-template-columns: minmax(0, 1fr); } }
.bl-decision { display: grid; gap: var(--space-md); }
.bl-decision-what { margin: 0; font-size: 0.9375rem; line-height: 1.5; }
.bl-reason small { color: var(--text-soft); font-size: 0.75rem; }
.bl-input { width: 100%; min-height: 2.5rem; padding: 0 var(--space-sm); border: 1px solid var(--control-border); border-radius: var(--radius-md); background: var(--surface-muted); color: var(--text); font: inherit; }
.bl-input:focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--focus-ring); }
.bl-decision-actions { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.bl-undo-preview { display: grid; gap: var(--space-sm); padding: var(--space-md); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-muted); }
.bl-undo-preview h3 { margin: 0; font-size: 0.9375rem; }
.bl-undo-list { display: grid; margin: 0; padding: 0; list-style: none; gap: var(--space-2xs); }
.bl-undo-list li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2xs) var(--space-md); padding: var(--space-xs) 0; border-bottom: 1px solid var(--line); }
.bl-undo-list span { color: var(--text-soft); }

/* Guided create */
.bl-wizard { display: grid; gap: var(--space-lg); max-width: 60rem; padding: var(--space-lg); }
.bl-steps { display: flex; margin: 0; padding: 0; list-style: none; gap: var(--space-xs); }
.bl-steps li { display: flex; flex: 1; align-items: center; gap: var(--space-xs); min-width: 0; padding-bottom: var(--space-xs); border-bottom: 2px solid var(--line); color: var(--text-soft); font-size: 0.875rem; font-weight: 600; }
.bl-steps li[aria-current] { border-bottom-color: var(--accent); color: var(--text); }
.bl-steps li[data-done] { border-bottom-color: var(--fine); }
.bl-step-dot { display: inline-grid; width: 1.5rem; height: 1.5rem; flex: none; place-items: center; border-radius: 50%; background: var(--surface-raised); font-size: 0.75rem; }
.bl-steps li[aria-current] .bl-step-dot { background: var(--accent-fill); color: var(--on-accent); }
.bl-steps li[data-done] .bl-step-dot { background: var(--fine-bg); color: var(--fine); }
.bl-step-dot .icon { width: 0.875rem; height: 0.875rem; }
.bl-step { display: grid; gap: var(--space-md); }
.bl-step h3 { margin: 0; font-size: 1.125rem; font-weight: 650; }
.bl-step > .bl-help { margin-top: calc(var(--space-sm) * -1); }
.bl-step .picker-field { max-width: 28rem; }
.bl-step-pickers { display: flex; flex-wrap: wrap; gap: var(--space-md); }
.bl-step-pickers > .picker-field { flex: 1 1 14rem; }
.bl-choice { display: flex; align-items: center; gap: var(--space-sm); padding: var(--space-sm) var(--space-md); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-muted); }
.bl-choice > span { display: grid; }
.bl-choice small { color: var(--text-soft); font-size: 0.8125rem; }
.bl-review { display: grid; margin: 0; border: 1px solid var(--line); border-radius: var(--radius-md); }
.bl-review > div { display: grid; gap: var(--space-2xs) var(--space-md); padding: var(--space-sm) var(--space-md); grid-template-columns: 9rem minmax(0, 1fr); }
.bl-review > div + div { border-top: 1px solid var(--line); }
.bl-review dt { color: var(--text-soft); font-size: 0.8125rem; font-weight: 600; }
.bl-review dd { display: grid; margin: 0; overflow-wrap: anywhere; }
.bl-review dd small { color: var(--text-soft); }
.bl-wizard-actions { display: flex; justify-content: space-between; gap: var(--space-xs); }
.bl-flip { transform: rotate(180deg); }
.bl-wizard-done { display: flex; align-items: flex-start; gap: var(--space-md); max-width: 48rem; padding: var(--space-lg); }
.bl-wizard-done h2 { margin: 0; font-size: 1.125rem; }
.bl-wizard-done p { margin: var(--space-xs) 0 var(--space-md); color: var(--text-soft); }

/* Compare */
.bl-compare-form { display: grid; gap: var(--space-md); padding: var(--space-lg); }
.bl-compare-form h2 { margin: 0; font-size: 1.125rem; font-weight: 650; }
.bl-quick { display: grid; margin: 0; padding: 0; list-style: none; gap: var(--space-sm); grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
.bl-quick-link { display: grid; gap: var(--space-2xs); height: 100%; padding: var(--space-sm) var(--space-md); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface-muted); }
.bl-quick-link small { color: var(--text-soft); font-size: 0.8125rem; }
.bl-quick-link[aria-current] { border-color: var(--text-soft); box-shadow: inset 0 0 0 1px var(--text-soft); background: var(--surface-raised); }
.bl-compare-pickers { display: grid; align-items: end; gap: var(--space-sm); grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr) auto; }
.bl-swap { margin-bottom: 0.125rem; }
.bl-compare-title { display: flex; flex-wrap: wrap; align-items: center; margin: 0; gap: var(--space-xs) var(--space-sm); font-size: 1rem; font-weight: 600; }
.bl-side { display: inline-grid; min-width: 0; padding: var(--space-2xs) var(--space-sm); border-radius: var(--radius-md); background: var(--surface-muted); overflow-wrap: anywhere; }
.bl-side small { color: var(--text-soft); font-size: 0.75rem; font-weight: 600; }
.bl-side[data-side="before"] { box-shadow: inset 3px 0 0 var(--neutral); }
.bl-side[data-side="after"] { box-shadow: inset 3px 0 0 var(--text-soft); }
.bl-sides-arrow { width: 1rem; height: 1rem; color: var(--text-muted); }
.bl-service-heading { display: flex; align-items: center; gap: var(--space-xs); }
.bl-service-heading .icon { color: var(--text-soft); }
.compare-kind { overflow: hidden; margin-top: var(--space-xs); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); }
.compare-kind-heading { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2xs) var(--space-sm); margin: 0; padding: var(--space-xs) var(--space-md); background: var(--surface-raised); color: var(--text); font-size: 0.8125rem; font-weight: 700; }
.compare-kind-heading small { color: var(--text-soft); font-size: 0.75rem; font-weight: 500; }
.bl-sides-list { display: grid; margin: 0; padding: 0; list-style: none; gap: var(--space-xs); }
.bl-sides-row { display: grid; align-items: center; gap: var(--space-xs) var(--space-sm); grid-template-columns: minmax(8rem, 1fr) minmax(0, 1.2fr) auto minmax(0, 1.2fr); }
.bl-sides-name { font-weight: 600; font-size: 0.875rem; overflow-wrap: anywhere; }
.bl-sides-row .bl-side { font-family: var(--font-mono); font-size: 0.8125rem; }
.bl-sides-row .bl-side small { font-family: var(--font-sans); }
.bl-presence { display: inline-flex; flex-wrap: wrap; align-items: center; margin-left: auto; gap: var(--space-xs); font-size: 0.8125rem; }
details.compare-group > summary { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; list-style: none; transition: background-color var(--duration-fast) var(--ease-out); }
.compare-group > summary::-webkit-details-marker { display: none; }
.compare-group > summary:hover { background: var(--surface-muted); }
.compare-group > summary:active { background: var(--surface-raised); }
.compare-group-counts { text-align: right; }
.compare-group-chevron { width: 1rem; height: 1rem; color: var(--text-soft); transition: transform var(--duration-fast) var(--ease-out); }
.compare-group[open] > summary .compare-group-chevron { transform: rotate(180deg); }
.compare-item-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); }
.compare-summary.bl-tiles div { padding: var(--space-sm) var(--space-md); }

@media (max-width: 61.99rem) {
  .bl-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bl-fact:nth-child(3) { border-left: 0; }
  .bl-fact:nth-child(n + 3) { border-top: 1px solid var(--line); }
  .bl-version { grid-template-columns: 2.25rem minmax(0, 1fr); grid-template-areas: "icon name" ". chip" ". when" ". actions"; align-items: start; }
  .bl-version > .bl-chip { justify-self: start; }
  .bl-job { flex-wrap: wrap; align-items: flex-start; }
  .bl-job-name { flex-basis: calc(100% - 2.25rem - var(--space-md)); }
  .bl-job > .bl-chip { margin-left: calc(2.25rem + var(--space-md)); }
  .bl-version-actions { justify-content: flex-start; }
  .bl-version-actions:empty { display: none; }
  .bl-sheet, .bl-sheet[data-wide] { top: auto; width: 100%; height: 100%; border-left: 0; animation-name: sheet-up; }
}
@media (max-width: 40rem) {
  details.compare-group > summary { grid-template-columns: minmax(0, 1fr) auto; }
  details.compare-group > summary .compare-group-counts { grid-column: 1; grid-row: 2; text-align: left; }
  details.compare-group > summary .compare-group-chevron { grid-column: 2; grid-row: 1 / span 2; }
  .bl-current, .bl-wizard, .bl-compare-form { padding: var(--space-md); }
  .bl-facts { grid-template-columns: minmax(0, 1fr); }
  .bl-fact + .bl-fact { border-left: 0; border-top: 1px solid var(--line); }
  .bl-row { flex-wrap: wrap; gap: var(--space-2xs) var(--space-sm); }
  .bl-row > .bl-kind-icon { display: none; }
  .bl-row-name { flex-basis: 100%; }
  .bl-row-who { display: block; flex-basis: 100%; min-width: 0; color: var(--text-soft); text-align: left; }
  .bl-tiles:not(.compare-summary) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .bl-row-who > span + small::before { content: " · "; }
  .bl-compare-pickers { grid-template-columns: minmax(0, 1fr); }
  .bl-swap { justify-self: center; transform: rotate(90deg); }
  .bl-sides-row { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); }
  .bl-sides-name { grid-column: 1 / -1; }
  .bl-review > div { grid-template-columns: minmax(0, 1fr); }
  .bl-steps li { flex-direction: column; align-items: flex-start; gap: var(--space-2xs); font-size: 0.75rem; }
  .bl-sheet-head, .bl-sheet-body { padding-left: var(--space-md); padding-right: var(--space-md); }
  .bl-sheet-foot { padding-left: var(--space-md); padding-right: var(--space-md); }
  .bl-sheet-foot .btn { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .bl-sheet, .bl-sheet-scrim { animation: none; }
  .bl-link, .bl-go .icon, .compare-group > summary, .compare-group-chevron { transition: none; }
}
`;

export function BaselinesStyles() {
  return <style href="keel-baselines" precedence="default">{CSS}</style>;
}
