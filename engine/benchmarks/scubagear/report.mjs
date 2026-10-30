/**
 * The ScubaGear coverage report as Markdown. It is checked in at
 * docs/roadmap/benchmark-content/scubagear-coverage.md and a test keeps that file equal
 * to this output, so the report can never drift from the pinned rules or Keel's reads.
 * Regenerate it with: node tools/scubagear-rules.mjs report --write
 */
import { PRODUCT_ORDER, RULE_STATES } from './import.mjs';

export const STATE_LABELS = Object.freeze({
  ready: 'Ready: Keel reads everything it needs',
  partial: 'Partly read: Keel reads it through another API, some fields may be missing',
  'missing-input': 'Could not check: Keel does not read an input it needs',
  manual: 'Check by hand: CISA has no automated check',
});
const SHORT = Object.freeze({ ready: '🟢 Ready', partial: '🟡 Partly read', 'missing-input': '🔴 Could not check', manual: '⚪ Check by hand' });
const byId = (left, right) => left.id.localeCompare(right.id, 'en', { numeric: true });
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function renderCoverageMarkdown(imported, coverage) {
  const lines = [];
  const push = (...items) => lines.push(...items);
  push(
    '# ScubaGear rule coverage',
    '',
    `Generated from CISA ScubaGear ${imported.version} (commit \`${imported.commitSha.slice(0, 7)}\`, public domain) by \`node tools/scubagear-rules.mjs report --write\`. Do not edit by hand: a test fails when this file and the generator differ.`,
    '',
    `**${imported.total} rules** across ${PRODUCT_ORDER.length} products. For each rule this lists what ScubaGear reads to check it and whether Keel reads the same data. Nothing here has run a rule yet; this is what will be possible when the rules run on Keel's backups.`,
    '',
    '## Summary',
    '',
    `| Product | Rules | SHALL | SHOULD | ${RULE_STATES.map((state) => SHORT[state]).join(' | ')} |`,
    `|---|---:|---:|---:|${RULE_STATES.map(() => '---:').join('|')}|`,
  );
  for (const product of PRODUCT_ORDER) {
    const count = imported.counts[product];
    const states = coverage.perProduct[product];
    push(`| ${count.name} | ${count.rules} | ${count.shall} | ${count.should} | ${RULE_STATES.map((state) => states[state]).join(' | ')} |`);
  }
  const shall = PRODUCT_ORDER.reduce((sum, product) => sum + imported.counts[product].shall, 0);
  push(
    `| **All** | **${imported.total}** | **${shall}** | **${imported.total - shall}** | ${RULE_STATES.map((state) => `**${coverage.summary[state]}**`).join(' | ')} |`,
    '',
    ...RULE_STATES.map((state) => `- ${SHORT[state]}: ${STATE_LABELS[state].split(': ')[1]}.`),
    '',
    '## What Keel does not read yet',
    '',
    'Each row is one input. Reading it would move every listed rule out of "Could not check".',
    '',
    '| Input | ScubaGear reads it with | Rules | Why Keel does not have it |',
    '|---|---|---|---|',
  );
  for (const missing of coverage.missingInputs) {
    push(`| \`${missing.key}\` | ${cell(missing.from)} | ${missing.rules.length}: ${missing.rules.join(', ')} | ${cell(missing.note ?? '')} |`);
  }
  for (const product of PRODUCT_ORDER) {
    push('', `## ${imported.counts[product].name}`, '', '| Rule | Level | Keel | Statement | Inputs |', '|---|---|---|---|---|');
    for (const rule of coverage.rules.filter((candidate) => candidate.product === product).sort(byId)) {
      const inputs = rule.inputs
        .filter((input) => !['run-setting', 'run-status'].includes(input.state))
        .map((input) => `\`${input.key}\`${input.state === 'read' ? '' : ` (${input.state === 'partial' ? 'partly read' : 'not read'})`}`);
      push(`| ${rule.id} | ${rule.criticality} | ${SHORT[rule.state]} | ${cell(rule.title)} | ${inputs.join(', ') || 'none'} |`);
    }
  }
  push(
    '',
    '## Technical details',
    '',
    `- Rule ids the Rego still reports but no baseline lists (left out of the counts): ${imported.regoOnly.join(', ') || 'none'}.`,
    `- Rules whose NIST mapping is in the baseline but has no row in CISA's CSV: ${imported.nistNotInCsv.join(', ') || 'none'}.`,
    `- Rules where CISA's CSV and the baseline disagree (the baseline is used): ${imported.nistDiffers.map((d) => `${d.id} (baseline ${d.markdown.join(', ')}; CSV ${d.csv.join(', ')})`).join('; ') || 'none'}.`,
    '- Inputs are found by reading the Rego statically, following helper rules; a rule may be listed as reading an input on a branch it does not always take.',
    '- Run settings (ScubaGear config, module version, tenant id) and run status (licence flags derived from Keel\'s own reads) are supplied by Keel and are not listed as inputs above.',
    '',
  );
  return lines.join('\n');
}
