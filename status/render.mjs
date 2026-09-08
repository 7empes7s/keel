// status/render.mjs
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function fmtAge(date) {
  if (!date) return 'never';
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The page answers one question before any other: is the tenant protected right
 * now. Everything below the verdict is the evidence for it, so the verdict is
 * derived from that same evidence and never softened — a broken evidence chain
 * outranks everything, and an unset baseline is stated plainly rather than
 * dressed up as a warning about something else.
 */
export function deriveVerdict(governance) {
  const driftTotal = governance.openDrift.reduce((sum, d) => sum + d.count, 0);

  if (!governance.evidence.ok) {
    return {
      tone: 'bad',
      statement: 'The evidence chain is broken.',
      detail: 'Governance records cannot be trusted until this is investigated.',
    };
  }
  if (!governance.lastCollection) {
    return {
      tone: 'bad',
      statement: 'Nothing has been collected.',
      detail: 'KEEL holds no snapshot of this tenant, so there is nothing to restore from.',
    };
  }
  if (!governance.baseline) {
    return {
      tone: 'warn',
      statement: 'No baseline is set.',
      detail: 'Collection is running, but without a baseline there is nothing to measure drift against.',
    };
  }
  if (governance.lastCollection.status !== 'complete') {
    return {
      tone: 'warn',
      statement: 'The last collection did not finish.',
      detail: 'The most recent snapshot is incomplete, so it may not hold everything it should.',
    };
  }
  if (driftTotal > 0) {
    return {
      tone: 'warn',
      statement: driftTotal === 1 ? 'One change is waiting on a decision.' : `${driftTotal} changes are waiting on a decision.`,
      detail: 'The tenant has moved away from its baseline. Each change needs to be accepted or rolled back.',
    };
  }
  return {
    tone: 'ok',
    statement: 'Protection is current.',
    detail: 'The tenant matches its baseline, and the record of how it got there is intact.',
  };
}

function ticks(done, total) {
  if (total <= 0) return '';
  return Array.from({ length: total }, (_, i) => `<i class="tick${i < done ? ' on' : ''}"></i>`).join('');
}

const STYLES = `
:root {
  color-scheme: light dark;
  --paper: #eef1f5;
  --panel: #f7f9fb;
  --ink: #14202f;
  --muted: #5c6e84;
  --rule: #ccd6e0;
  --rule-soft: #dfe6ed;
  --ok: #0f5f4e;
  --warn: #855605;
  --bad: #8f2329;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0d131b;
    --panel: #141d27;
    --ink: #e3ebf3;
    --muted: #8ea0b4;
    --rule: #26323f;
    --rule-soft: #1d2732;
    --ok: #4fc0a3;
    --warn: #dfa64a;
    --bad: #e8767d;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: 0 1.5rem 5rem; }

/* masthead */
.masthead {
  display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem;
  align-items: baseline; justify-content: space-between;
  padding: 1.75rem 0 1rem;
  border-bottom: 1px solid var(--rule);
}
.wordmark { font-size: 1.05rem; font-weight: 650; letter-spacing: 0.14em; margin: 0; }
.wordmark span { color: var(--muted); font-weight: 400; letter-spacing: 0; margin-left: 0.9rem; }
.checked { color: var(--muted); font-size: 0.82rem; margin: 0; }

/* the one bold moment */
.verdict { padding: 3.25rem 0 2.75rem; max-width: 34ch; }
.verdict p {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: clamp(2rem, 6.5vw, 3.1rem);
  line-height: 1.08;
  margin: 0;
  letter-spacing: -0.015em;
}
.verdict .detail {
  font-family: inherit; font-size: 0.95rem; line-height: 1.6;
  color: var(--muted); margin-top: 1.1rem; max-width: 46ch;
}
.verdict::before {
  content: ""; display: block;
  width: 2.25rem; height: 3px; margin-bottom: 1.5rem;
  background: var(--tone);
}
.tone-ok { --tone: var(--ok); }
.tone-warn { --tone: var(--warn); }
.tone-bad { --tone: var(--bad); }

/* readings */
.readings {
  display: grid; grid-template-columns: repeat(4, 1fr);
  border: 1px solid var(--rule); border-radius: 4px;
  background: var(--panel); overflow: hidden;
}
.reading { padding: 1rem 1.15rem; border-left: 1px solid var(--rule-soft); }
.reading:first-child { border-left: 0; }
.reading b { display: block; font-size: 1.15rem; font-weight: 600; }
.reading small { display: block; color: var(--muted); font-size: 0.8rem; margin-top: 0.15rem; }
.reading.is-bad b { color: var(--bad); }
.reading.is-ok b { color: var(--ok); }

/* sections */
section { padding-top: 3rem; }
h2 { font-size: 1.15rem; font-weight: 620; margin: 0 0 0.35rem; letter-spacing: -0.01em; }
.lede { color: var(--muted); font-size: 0.88rem; margin: 0 0 1.25rem; max-width: 58ch; }

/* holdings */
.holdings { columns: 2; column-gap: 3rem; }
.holding {
  display: flex; justify-content: space-between; gap: 1rem;
  padding: 0.4rem 0; border-bottom: 1px solid var(--rule-soft);
  break-inside: avoid;
}
.holding span { color: var(--muted); }
.holding small { display: block; text-align: right; font-size: 0.72rem; }
.empty { color: var(--muted); font-style: italic; }

/* tables — three short columns look adrift at full page width */
table { border-collapse: collapse; width: 100%; max-width: 34rem; }
table.drift th:first-child, table.drift td:first-child { width: 45%; }
th, td { text-align: left; padding: 0.5rem 0.9rem 0.5rem 0; border-bottom: 1px solid var(--rule-soft); }
th { font-size: 0.78rem; font-weight: 600; color: var(--muted); }
td.n, th.n { text-align: right; padding-right: 0; }

/* build */
.milestone { padding: 0.7rem 0; border-bottom: 1px solid var(--rule-soft); }
.milestone-head { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; }
.milestone-head b { font-weight: 550; }
.milestone-head span { color: var(--muted); font-size: 0.85rem; }
.ticks { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 0.55rem; }
.tick { width: 12px; height: 5px; border-radius: 1px; background: var(--rule); }
.tick.on { background: var(--ok); }
.commits { list-style: none; margin: 1.25rem 0 0; padding: 0; }
.commits li { padding: 0.35rem 0; border-bottom: 1px solid var(--rule-soft); display: flex; gap: 0.9rem; }
.commits code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.82rem; color: var(--muted); flex: none;
}
footer {
  margin-top: 3.5rem; padding-top: 1.25rem;
  border-top: 1px solid var(--rule);
  color: var(--muted); font-size: 0.82rem; max-width: 62ch;
}
@media (max-width: 46rem) {
  .readings { grid-template-columns: repeat(2, 1fr); }
  .reading:nth-child(3) { border-left: 0; }
  .reading:nth-child(n+3) { border-top: 1px solid var(--rule-soft); }
  .holdings { columns: 1; }
}
`;

export function renderPage({ buildProgress, governance, generatedAt }) {
  const verdict = deriveVerdict(governance);
  const driftTotal = governance.openDrift.reduce((sum, d) => sum + d.count, 0);

  const milestones = buildProgress.phases
    .map((p) => `<div class="milestone">
        <div class="milestone-head"><b>${escapeHtml(p.name)}</b><span>${p.done}/${p.total}</span></div>
        <div class="ticks" role="img" aria-label="${p.done} of ${p.total} tasks shipped">${ticks(p.done, p.total)}</div>
      </div>`)
    .join('\n');

  const commitRows = buildProgress.recentCommits
    .map((c) => `<li><code>${escapeHtml(c.hash)}</code> ${escapeHtml(c.subject)}</li>`)
    .join('\n');

  const holdings = governance.resourceCounts.byType
    .map((t) => {
      const asOf = t.asOf ? new Date(t.asOf).toISOString() : null;
      const age = asOf ? `<small><time datetime="${asOf}" title="${asOf}">${escapeHtml(fmtAge(asOf))}</time></small>` : '';
      return `<div class="holding">${escapeHtml(t.resourceType)}<span>${t.count ?? 'unavailable'}${age}</span></div>`;
    })
    .join('\n') || '<p class="empty">Nothing collected yet.</p>';

  // With no drift there is nothing to tabulate, so the table drops its header
  // and states the fact in one line. A header above an empty body reads as a
  // rendering failure rather than as good news.
  const driftTable = governance.openDrift.length > 0
    ? `<table class="drift">
    <tr><th>Change</th><th>Blast radius</th><th class="n">Count</th></tr>
${governance.openDrift
    .map((d) => `    <tr><td>${escapeHtml(d.changeType)}</td><td>${escapeHtml(d.blastRadius)}</td><td class="n">${d.count}</td></tr>`)
    .join('\n')}
  </table>`
    : `<table class="drift">
    <tr><td colspan="3" class="empty">The tenant still matches its baseline. Changes outstanding: none</td></tr>
  </table>`;

  const dispositionSummary = governance.recentDispositions
    .map((d) => `${d.count} ${escapeHtml(d.action)}`)
    .join(', ') || 'none';

  const evidenceWord = governance.evidence.ok ? 'intact' : 'BROKEN';
  const collectionReading = governance.lastCollection
    ? `${escapeHtml(fmtAge(governance.lastCollection.completedAt))}`
    : 'never';
  const collectionNote = governance.lastCollection
    ? `last collection, ${escapeHtml(governance.lastCollection.status)}`
    : 'no collection has run';
  const baselineReading = governance.baseline ? escapeHtml(fmtAge(governance.baseline.setAt)) : 'none set';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KEEL status</title>
<meta name="description" content="Live protection status for the tenant KEEL is holding: collection freshness, baseline age, open drift and evidence-chain integrity.">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">

<header class="masthead">
  <h1 class="wordmark">KEEL<span>Microsoft 365 configuration recovery</span></h1>
  <p class="checked">data as of ${escapeHtml(new Date(generatedAt).toISOString())}</p>
</header>

<div class="verdict tone-${verdict.tone}">
  <p>${escapeHtml(verdict.statement)}</p>
  <p class="detail">${escapeHtml(verdict.detail)}</p>
</div>

<div class="readings">
  <div class="reading">
    <b>${collectionReading}</b>
    <small>${collectionNote}</small>
  </div>
  <div class="reading">
    <b>${baselineReading}</b>
    <small>baseline set</small>
  </div>
  <div class="reading">
    <b>${driftTotal}</b>
    <small>${driftTotal === 1 ? 'change awaiting a decision' : 'changes awaiting a decision'}</small>
  </div>
  <div class="reading ${governance.evidence.ok ? 'is-ok' : 'is-bad'}">
    <b>${evidenceWord}</b>
    <small>evidence chain, ${governance.evidence.chainLength} records</small>
  </div>
</div>

<section>
  <h2>What KEEL is holding</h2>
  <p class="lede">Object counts from each type's latest completed collection, with its age. Counts only — this page never shows
    which objects, or anything stored inside them.</p>
  <div class="holdings">
${holdings}
  </div>
</section>

<section>
  <h2>Changes since the baseline</h2>
  <p class="lede">Drift the tenant has accumulated, grouped by what changed and how much it can
    affect. Recent decisions, last 7 days: ${dispositionSummary}.</p>
  ${driftTable}
</section>

<section>
  <h2>Build</h2>
  <p class="lede">Progress against the two engine milestones, one mark per task.
    ${buildProgress.testFileCount} test files.</p>
${milestones}
  <ul class="commits">
${commitRows}
  </ul>
</section>

<footer>
  KEEL takes versioned snapshots of Microsoft 365 identity and device configuration, measures them
  against an approved baseline, and can restore what changed. This page is generated from the live
  database every 60 seconds and is read-only.
</footer>

</div>
</body>
</html>
`;
}
