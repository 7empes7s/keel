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

// Why a rule does not run on Keel's backups, from its reason code (controls.mjs staticReason).
export function outcomeWords(reason) {
  const code = reason.replace(/^scubagear:/, '');
  const [kind, rest = ''] = [code.slice(0, code.indexOf(':') === -1 ? code.length : code.indexOf(':')), code.slice(code.indexOf(':') + 1)];
  if (kind === 'check-by-hand') return 'CISA marks it as a check to do by hand.';
  if (kind === 'not-read') return `Keel does not read \`${rest}\`.`;
  if (kind === 'field-not-read') {
    const [key, fields] = [rest.slice(0, rest.lastIndexOf('.')), rest.slice(rest.lastIndexOf('.') + 1)];
    return `Keel's read of \`${key}\` does not keep ${fields.split(',').map((field) => `\`${field}\``).join(', ')}.`;
  }
  if (kind === 'preview-only') {
    const [key, fields] = [rest.slice(0, rest.lastIndexOf('.')), rest.slice(rest.lastIndexOf('.') + 1)];
    return `Microsoft offers ${fields.split(',').map((field) => `\`${field}\``).join(', ')} of \`${key}\` only in a preview, which Keel does not back up.`;
  }
  if (kind === 'needs-setting') return 'It needs a list the tenant gives in ScubaGear\'s config (sensitive users or partner domains), which Keel has no place for yet.';
  return code;
}

/**
 * `outcomes` (controls.mjs scubaRuleOutcomes) adds what happens to each rule on Keel's
 * backups: it runs, or it is "could not check" and why.
 */
export function renderCoverageMarkdown(imported, coverage, outcomes = null) {
  const lines = [];
  const push = (...items) => lines.push(...items);
  push(
    '# ScubaGear rule coverage',
    '',
    `Generated from CISA ScubaGear ${imported.version} (commit \`${imported.commitSha.slice(0, 7)}\`, public domain) by \`node tools/scubagear-rules.mjs report --write\`. Do not edit by hand: a test fails when this file and the generator differ.`,
    '',
    `**${imported.total} rules** across ${PRODUCT_ORDER.length} products. For each rule this lists what ScubaGear reads to check it and whether Keel reads the same data. Every rule runs unchanged on Keel's backups as a Compliance page check (engine/benchmarks/scubagear/controls.mjs); a rule that also names a field Keel's read does not keep shows there as could not check, even when this table lists its inputs as read.`,
    '',
    ...(outcomes ? outcomeSummary(imported, outcomes) : []),
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
  if (outcomes) {
    push('', '## Could not check on Keel\'s backups', '', 'Each of these rules shows on the Compliance page as "could not check", with its reason. None is ever counted as a pass.', '',
      '| Rule | Why |', '|---|---|');
    for (const { rule, reason } of outcomes.filter((outcome) => outcome.reason).sort((left, right) => byId(left.rule, right.rule))) {
      push(`| ${rule.id} | ${cell(outcomeWords(reason))} |`);
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

function outcomeSummary(imported, outcomes) {
  const lines = ['## On Keel\'s backups', '', '| Product | Rules | Run | Could not check |', '|---|---:|---:|---:|'];
  for (const product of PRODUCT_ORDER) {
    const own = outcomes.filter((outcome) => outcome.rule.product === product);
    const blocked = own.filter((outcome) => outcome.reason).length;
    lines.push(`| ${imported.counts[product].name} | ${own.length} | ${own.length - blocked} | ${blocked} |`);
  }
  const blocked = outcomes.filter((outcome) => outcome.reason).length;
  lines.push(`| **All** | **${outcomes.length}** | **${outcomes.length - blocked}** | **${blocked}** |`, '');
  return lines;
}
