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

export function renderPage({ buildProgress, governance, generatedAt }) {
  const phaseRows = buildProgress.phases
    .map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.done}/${p.total}</td></tr>`)
    .join('\n');
  const commitRows = buildProgress.recentCommits
    .map((c) => `<li><code>${escapeHtml(c.hash)}</code> ${escapeHtml(c.subject)}</li>`)
    .join('\n');
  const typeRows = governance.resourceCounts.byType
    .map((t) => `<tr><td>${escapeHtml(t.resourceType)}</td><td>${t.count}</td></tr>`)
    .join('\n');
  const driftRows = governance.openDrift
    .map((d) => `<tr><td>${escapeHtml(d.changeType)}</td><td>${escapeHtml(d.blastRadius)}</td><td>${d.count}</td></tr>`)
    .join('\n') || '<tr><td colspan="3">none</td></tr>';
  const dispositionSummary = governance.recentDispositions
    .map((d) => `${d.count} ${escapeHtml(d.action)}`)
    .join(', ') || 'none';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>KEEL status</title>
<style>
  body { font: 14px system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  td, th { padding: 0.25rem 0.75rem; border-bottom: 1px solid #ddd; text-align: left; }
  h2 { margin-top: 2rem; }
  .stamp { color: #666; font-size: 0.85em; }
</style>
</head>
<body>
<h1>KEEL status</h1>
<p class="stamp">data as of ${escapeHtml(new Date(generatedAt).toISOString())}</p>

<h2>Build progress</h2>
<table><tr><th>Phase</th><th>Tasks</th></tr>
${phaseRows}
</table>
<p>${buildProgress.testFileCount} test files</p>
<h3>Recent commits</h3>
<ul>
${commitRows}
</ul>

<h2>Live tenant governance</h2>
<table><tr><th>Resource type</th><th>Tracked</th></tr>
${typeRows}
</table>
<p>Active baseline: ${governance.baseline ? escapeHtml(fmtAge(governance.baseline.setAt)) : 'none set'}</p>
<p>Last collection: ${governance.lastCollection ? `${escapeHtml(fmtAge(governance.lastCollection.completedAt))} (${escapeHtml(governance.lastCollection.status)})` : 'never'}</p>

<h3>Open drift</h3>
<table><tr><th>Change</th><th>Blast radius</th><th>Count</th></tr>
${driftRows}
</table>

<p>Evidence chain: ${governance.evidence.ok ? 'intact' : 'BROKEN'} (${governance.evidence.chainLength} records)</p>
<p>Recent dispositions (7d): ${dispositionSummary}</p>
</body>
</html>
`;
}
