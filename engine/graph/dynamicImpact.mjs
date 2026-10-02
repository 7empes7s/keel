/**
 * Task 60: bounded dynamic-group impact prediction.
 *
 * Question answered: "if this principal's attributes change, which dynamic
 * groups might its membership change in — directly, through rules that
 * reference other groups, and through static nesting above those groups?"
 *
 * The answer is a PREDICTION and is never labeled exact membership:
 *  - Entra evaluates dynamic rules asynchronously (rule-processing delay), and
 *    a paused rule does not update at all, so even a confident prediction is
 *    `predicted-change`, not a membership fact (`exactMembership: false`).
 *  - Only a small, documented rule subset is evaluated (SUPPORTED_RULE_SUBSET).
 *    Anything outside it is `possibly-affected` with reason
 *    `unsupported-expression` — never treated as false (non-matching).
 *  - Missing attribute values, unknown memberships, stale principal data,
 *    cyclic rule dependencies and an exhausted work budget all degrade to
 *    `possibly-affected` with a named reason, never to "no change".
 *
 * Evaluation uses three-valued logic (true / false / unknown) so an unknown
 * operand can only widen the bound. Work is bounded by `maxSteps` (clause
 * evaluations + nesting hops) and `maxMs` (injected clock), and every rule
 * dependency cycle terminates (per-group re-evaluation cap).
 */
import { impactFingerprint } from './impact.mjs';

export const SUPPORTED_RULE_SUBSET = Object.freeze({
  subjects: ['user', 'device'],
  operators: ['-eq', '-ne', '-startsWith', '-notStartsWith', '-contains', '-notContains', '-in', '-notIn'],
  logical: ['-and', '-or', '-not', '( )'],
  values: ['"string"', "'string'", 'true', 'false', 'null', '[list]'],
  membership: ['user.memberof -any (group.objectId -in [...])', 'device.memberof -any (group.objectId -in [...])'],
  note: 'Comparisons are case-insensitive. Any other operator (-match, -le, -ge, -all, other -any forms) is unsupported.',
});

export const DEFAULT_DYNAMIC_BUDGET = Object.freeze({ maxSteps: 100_000, maxMs: 2_000 });
export const DEFAULT_MEMBER_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_REEVALUATIONS = 4;

export class UnsupportedRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnsupportedRuleError';
  }
}

// ------------------------------------------------------------------ parsing

function tokenize(rule) {
  const tokens = [];
  let i = 0;
  while (i < rule.length) {
    const ch = rule[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if ('()[],'.includes(ch)) { tokens.push({ kind: ch }); i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const end = rule.indexOf(ch, i + 1);
      if (end < 0) throw new UnsupportedRuleError('unterminated string');
      tokens.push({ kind: 'string', value: rule.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const match = /^-?[A-Za-z_][\w.]*/.exec(rule.slice(i));
    if (!match) throw new UnsupportedRuleError(`unexpected character ${JSON.stringify(ch)}`);
    const word = match[0];
    if (word.startsWith('-')) tokens.push({ kind: 'op', value: word.toLowerCase() });
    else if (/^(true|false)$/i.test(word)) tokens.push({ kind: 'bool', value: word.toLowerCase() === 'true' });
    else if (/^null$/i.test(word)) tokens.push({ kind: 'null' });
    else tokens.push({ kind: 'ident', value: word.toLowerCase() });
    i += word.length;
  }
  return tokens;
}

const COMPARISONS = new Set(SUPPORTED_RULE_SUBSET.operators.map((op) => op.toLowerCase()));

/** Parse a rule into an AST, or throw UnsupportedRuleError. */
export function parseMembershipRule(rule) {
  if (typeof rule !== 'string' || rule.trim().length === 0) throw new UnsupportedRuleError('empty rule');
  const tokens = tokenize(rule);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (kind, value) => {
    const token = tokens[pos];
    if (!token || token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new UnsupportedRuleError(`expected ${value ?? kind} at token ${pos}`);
    }
    pos += 1;
    return token;
  };
  const value = () => {
    const token = peek();
    if (!token) throw new UnsupportedRuleError('missing value');
    if (token.kind === 'string' || token.kind === 'bool') { pos += 1; return token.value; }
    if (token.kind === 'null') { pos += 1; return null; }
    if (token.kind === '[' || token.kind === '(') {
      const close = token.kind === '[' ? ']' : ')';
      pos += 1;
      const items = [];
      while (peek() && peek().kind !== close) {
        const item = take('string').value;
        items.push(item);
        if (peek()?.kind === ',') pos += 1;
      }
      take(close);
      return items;
    }
    throw new UnsupportedRuleError(`unsupported value at token ${pos}`);
  };
  const clause = () => {
    const ident = take('ident').value;
    const [subject, property, ...rest] = ident.split('.');
    if (!SUPPORTED_RULE_SUBSET.subjects.includes(subject) || !property || rest.length > 0) {
      throw new UnsupportedRuleError(`unsupported property ${ident}`);
    }
    const op = take('op').value;
    if (property === 'memberof') {
      if (op !== '-any') throw new UnsupportedRuleError(`unsupported memberof operator ${op}`);
      take('(');
      const inner = take('ident').value;
      if (inner !== 'group.objectid') throw new UnsupportedRuleError(`unsupported memberof predicate ${inner}`);
      take('op', '-in');
      const ids = value();
      if (!Array.isArray(ids)) throw new UnsupportedRuleError('memberof expects a list of group ids');
      take(')');
      return { type: 'memberOf', subject, groupIds: ids.map((id) => id.toLowerCase()) };
    }
    if (!COMPARISONS.has(op)) throw new UnsupportedRuleError(`unsupported operator ${op}`);
    const operand = value();
    if ((op === '-in' || op === '-notin') !== Array.isArray(operand)) throw new UnsupportedRuleError(`operator ${op} operand shape`);
    return { type: 'compare', subject, property, op, operand };
  };
  const unary = () => {
    if (peek()?.kind === 'op' && peek().value === '-not') { pos += 1; return { type: 'not', expr: unary() }; }
    if (peek()?.kind === '(') { pos += 1; const inner = orExpr(); take(')'); return inner; }
    return clause();
  };
  const andExpr = () => {
    let left = unary();
    while (peek()?.kind === 'op' && peek().value === '-and') { pos += 1; left = { type: 'and', left, right: unary() }; }
    return left;
  };
  function orExpr() {
    let left = andExpr();
    while (peek()?.kind === 'op' && peek().value === '-or') { pos += 1; left = { type: 'or', left, right: andExpr() }; }
    return left;
  }
  const ast = orExpr();
  if (pos !== tokens.length) throw new UnsupportedRuleError(`unexpected trailing token at ${pos}`);
  return ast;
}

/** Every attribute and group id a rule depends on. */
function ruleDependencies(ast, acc = { attributes: new Set(), groups: new Set() }) {
  if (ast.type === 'compare') acc.attributes.add(ast.property);
  else if (ast.type === 'memberOf') ast.groupIds.forEach((id) => acc.groups.add(id));
  else if (ast.type === 'not') ruleDependencies(ast.expr, acc);
  else { ruleDependencies(ast.left, acc); ruleDependencies(ast.right, acc); }
  return acc;
}

// --------------------------------------------------------------- evaluation

const U = 'unknown';
const not3 = (v) => (v === U ? U : !v);
const and3 = (a, b) => (a === false || b === false ? false : (a === U || b === U ? U : true));
const or3 = (a, b) => (a === true || b === true ? true : (a === U || b === U ? U : false));
const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

/**
 * Evaluate an AST. `attributes`: lowercased property -> value (absent = unknown,
 * null = explicit null). `memberOf(id)` -> true | false | 'unknown'.
 * `unknowns` collects why a result is unknown.
 */
function evaluate(ast, ctx) {
  ctx.step();
  switch (ast.type) {
    case 'not': return not3(evaluate(ast.expr, ctx));
    case 'and': return and3(evaluate(ast.left, ctx), evaluate(ast.right, ctx));
    case 'or': return or3(evaluate(ast.left, ctx), evaluate(ast.right, ctx));
    case 'memberOf': {
      let result = false;
      for (const id of ast.groupIds) {
        const v = ctx.memberOf(id);
        if (v === U) ctx.unknowns.add(`unknown-membership:${id}`);
        result = or3(result, v);
      }
      return result;
    }
    case 'compare': {
      if (!Object.hasOwn(ctx.attributes, ast.property)) {
        ctx.unknowns.add(`unknown-attribute:${ast.property}`);
        return U;
      }
      const actual = norm(ctx.attributes[ast.property]);
      const operand = Array.isArray(ast.operand) ? ast.operand.map(norm) : norm(ast.operand);
      switch (ast.op) {
        case '-eq': return actual === operand;
        case '-ne': return actual !== operand;
        case '-startswith': return typeof actual === 'string' && actual.startsWith(operand);
        case '-notstartswith': return !(typeof actual === 'string' && actual.startsWith(operand));
        case '-contains': return typeof actual === 'string' && actual.includes(operand);
        case '-notcontains': return !(typeof actual === 'string' && actual.includes(operand));
        case '-in': return operand.includes(actual);
        case '-notin': return !operand.includes(actual);
        default: throw new UnsupportedRuleError(`unsupported operator ${ast.op}`);
      }
    }
    default: throw new UnsupportedRuleError(`unsupported node ${ast.type}`);
  }
}

class BudgetExhausted extends Error {}

function lowerKeys(object) {
  return Object.fromEntries(Object.entries(object ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * @param principal { naturalKey, subject: 'user'|'device', observedAt,
 *                    before: { attributes, memberOf: [groupId], memberOfComplete },
 *                    after:  { attributes } }
 * @param groups    dynamic groups: { naturalKey, sourceId, membershipRule,
 *                    processingState ('On'|'Paused'), isAssignableToRole }
 * @param nesting   static edges: { parentSourceId, memberSourceId } (member group inside parent)
 */
export function predictDynamicImpact({
  principal, groups, nesting = [], budget = {}, now = new Date(), clock = () => Date.now(),
  staleAfterMs = DEFAULT_MEMBER_STALE_AFTER_MS,
}) {
  const limits = { ...DEFAULT_DYNAMIC_BUDGET, ...budget };
  const startedAt = clock();
  let steps = 0;
  let exhausted = null;
  const step = () => {
    steps += 1;
    if (steps > limits.maxSteps) throw new BudgetExhausted('steps');
    if (clock() - startedAt > limits.maxMs) throw new BudgetExhausted('time');
  };

  const subject = principal.subject ?? 'user';
  const before = lowerKeys(principal.before?.attributes);
  const after = lowerKeys(principal.after?.attributes);
  const changedAttributes = new Set(
    [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => !Object.hasOwn(before, key) || !Object.hasOwn(after, key) || norm(before[key]) !== norm(after[key])),
  );
  const beforeMembership = new Set((principal.before?.memberOf ?? []).map((id) => id.toLowerCase()));
  const membershipComplete = principal.before?.memberOfComplete === true;
  const stale = principal.observedAt ? now - new Date(principal.observedAt) > staleAfterMs : false;

  const byId = new Map();
  for (const group of [...groups].sort((a, b) => a.naturalKey.localeCompare(b.naturalKey))) {
    const id = String(group.sourceId).toLowerCase();
    const entry = { group, id, reasons: new Set(), via: new Set() };
    try {
      entry.ast = parseMembershipRule(group.membershipRule);
      entry.deps = ruleDependencies(entry.ast);
      // A rule over the other subject type (device rule for a user) cannot
      // change with this principal at all.
      entry.applies = JSON.stringify(entry.ast).includes(`"subject":"${subject}"`);
    } catch (error) {
      if (!(error instanceof UnsupportedRuleError)) throw error;
      entry.unsupported = error.message;
      entry.applies = true;
    }
    byId.set(id, entry);
  }

  // Observed memberships cover static groups (and anything not modelled as a
  // dynamic rule here); dynamic group membership comes from solving the rules.
  const observedMemberOf = (id) => (beforeMembership.has(id) ? true : (membershipComplete ? false : U));
  const dependents = new Map(); // group id -> entries whose rule references it
  for (const entry of byId.values()) {
    for (const dep of entry.deps?.groups ?? []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(entry);
    }
  }

  /**
   * Solve every applicable rule to a fixpoint for one world (before or after
   * the change). A changed dynamic membership re-queues every rule that
   * references it — the dynamic reverse impact. Re-evaluation is capped per
   * group, so an oscillating rule dependency settles on unknown and always
   * terminates. Unsupported rules contribute unknown membership (never false).
   */
  const solve = (attributes, world) => {
    const values = new Map();
    for (const entry of byId.values()) if (entry.unsupported) values.set(entry.id, U);
    const memberOf = (id) => (values.has(id) ? values.get(id) : observedMemberOf(id));
    const evaluations = new Map();
    const queue = [...byId.values()].filter((entry) => !entry.unsupported && entry.applies);
    const queued = new Set(queue);
    const requeueDependents = (entry) => {
      for (const dependent of dependents.get(entry.id) ?? []) {
        if (dependent.unsupported || !dependent.applies || queued.has(dependent)) continue;
        queue.push(dependent);
        queued.add(dependent);
      }
    };
    while (queue.length > 0) {
      const entry = queue.shift();
      queued.delete(entry);
      const count = (evaluations.get(entry) ?? 0) + 1;
      evaluations.set(entry, count);
      if (count > MAX_REEVALUATIONS) {
        entry.reasons.add('cyclic-rule-dependency');
        if (values.get(entry.id) !== U) { values.set(entry.id, U); requeueDependents(entry); }
        continue;
      }
      const unknowns = new Set();
      const value = evaluate(entry.ast, { attributes, memberOf, unknowns, step });
      if (world === 'after' || value === U) unknowns.forEach((u) => entry.reasons.add(u));
      const previous = values.has(entry.id) ? values.get(entry.id) : observedMemberOf(entry.id);
      values.set(entry.id, value);
      if (value !== previous) requeueDependents(entry);
    }
    return values;
  };

  let beforeValues = new Map();
  let afterValues = new Map();
  try {
    beforeValues = solve(before, 'before');
    afterValues = solve(after, 'after');
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    exhausted = error.message;
  }
  const valueIn = (values, id) => (values.has(id) ? values.get(id) : observedMemberOf(id));
  for (const entry of byId.values()) {
    entry.before = beforeValues.get(entry.id);
    // Indirect cause: referenced groups whose solved membership differs.
    for (const dep of entry.deps?.groups ?? []) {
      if (valueIn(beforeValues, dep) !== valueIn(afterValues, dep)) {
        const source = byId.get(dep);
        entry.via.add(source ? source.group.naturalKey : `group-id:${dep}`);
      }
    }
  }
  const afterMemberOf = (id) => valueIn(afterValues, id);
  const beforeMemberOf = (id) => valueIn(beforeValues, id);

  const results = [];
  const byNaturalKey = new Map();
  for (const entry of byId.values()) {
    const { group } = entry;
    const reasons = new Set(entry.reasons);
    let outcome;
    let direction = null;
    const dependsOnChange = entry.unsupported || [...(entry.deps?.attributes ?? [])].some((a) => changedAttributes.has(a))
      || entry.via.size > 0 || [...(entry.deps?.groups ?? [])].some((id) => afterMemberOf(id) !== beforeMemberOf(id));
    if (entry.unsupported) {
      outcome = 'possibly-affected';
      reasons.add('unsupported-expression');
    } else if (!entry.applies) {
      outcome = 'no-predicted-change';
    } else if (exhausted && (dependsOnChange || entry.deps.groups.size > 0 || entry.before === undefined || !afterValues.has(entry.id))) {
      // A cut-short fixpoint may hold values that were never propagated, so
      // anything that could depend on the change is only possibly affected.
      outcome = 'possibly-affected';
      reasons.add('work-budget-exhausted');
    } else {
      const b = entry.before;
      const a = afterValues.get(entry.id);
      if (b === U || a === U) outcome = 'possibly-affected';
      else if (b !== a) { outcome = 'predicted-change'; direction = a ? 'join' : 'leave'; }
      else outcome = 'no-predicted-change';
      if (outcome !== 'possibly-affected') reasons.clear();
      if (stale && dependsOnChange && outcome !== 'possibly-affected') { outcome = 'possibly-affected'; reasons.add('stale-member-data'); }
    }
    if (outcome === 'predicted-change' && String(group.processingState ?? 'On').toLowerCase() !== 'on') {
      outcome = 'possibly-affected';
      reasons.add('rule-processing-paused');
    }
    const result = {
      naturalKey: group.naturalKey, sourceId: entry.id, outcome, direction,
      indirect: entry.via.size > 0 && ![...(entry.deps?.attributes ?? [])].some((a) => changedAttributes.has(a)),
      via: [...entry.via].sort(), reasons: [...reasons].sort(), isAssignableToRole: group.isAssignableToRole === true,
      kind: 'dynamic',
    };
    results.push(result);
    byNaturalKey.set(group.naturalKey, result);
  }

  // Static nesting above any group whose membership may change: the
  // principal's transitive membership there may change too. Other paths into
  // the parent are not modelled, so this is always possibly-affected.
  const parentsOf = new Map();
  for (const edge of nesting) {
    const member = String(edge.memberSourceId).toLowerCase();
    if (!parentsOf.has(member)) parentsOf.set(member, []);
    parentsOf.get(member).push(edge);
  }
  const nestedResults = new Map();
  const frontier = results.filter((r) => r.outcome !== 'no-predicted-change').map((r) => ({ id: r.sourceId, via: r.naturalKey }));
  const seen = new Set(frontier.map((f) => f.id));
  try {
    while (frontier.length > 0 && !exhausted) {
      const { id, via } = frontier.shift();
      for (const edge of parentsOf.get(id) ?? []) {
        step();
        const parentId = String(edge.parentSourceId).toLowerCase();
        const key = edge.parentNaturalKey ?? `group-id:${parentId}`;
        if (byNaturalKey.has(key)) continue; // a dynamic group already analysed
        const existing = nestedResults.get(key) ?? {
          naturalKey: key, sourceId: parentId, outcome: 'possibly-affected', direction: null, indirect: true,
          via: [], reasons: ['nested-membership'], isAssignableToRole: edge.parentIsAssignableToRole === true, kind: 'static-nesting',
        };
        if (!existing.via.includes(via)) existing.via.push(via);
        existing.via.sort();
        nestedResults.set(key, existing);
        if (!seen.has(parentId)) { seen.add(parentId); frontier.push({ id: parentId, via: key }); }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    exhausted = error.message;
  }
  const all = [...results, ...nestedResults.values()].sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
  const count = (outcome) => all.filter((r) => r.outcome === outcome).length;
  const predicted = count('predicted-change');
  const possibly = count('possibly-affected');
  return {
    principal: principal.naturalKey,
    exactMembership: false,
    complete: exhausted === null,
    caveats: ['rule-processing-delay'],
    results: all,
    summary: {
      predictedChange: predicted, possiblyAffected: possibly, noPredictedChange: count('no-predicted-change'),
      // A bound, never a count of actual membership changes.
      bounds: { atLeastPredicted: predicted, atMost: exhausted ? null : predicted + possibly },
    },
    budget: { steps, maxSteps: limits.maxSteps, elapsedMs: clock() - startedAt, maxMs: limits.maxMs, exhausted },
  };
}

/**
 * Fold a dynamic prediction into a task-59 impact analysis: the disclosure
 * lists every dynamic/nested group not predicted unchanged, and any such
 * group (or an incomplete prediction) makes the impact claim non-exact.
 */
export function discloseDynamicImpact(analysis, prediction) {
  const affected = prediction.results.filter((r) => r.outcome !== 'no-predicted-change');
  const reasons = [...analysis.completeness.reasons];
  if (affected.length > 0) reasons.push({ reason: 'dynamic-membership-predicted', groups: affected.map((r) => r.naturalKey) });
  if (!prediction.complete) reasons.push({ reason: 'dynamic-prediction-incomplete', exhausted: prediction.budget.exhausted });
  const status = reasons.length === 0 ? analysis.completeness.status
    : (analysis.completeness.status === 'exact' ? 'incomplete' : analysis.completeness.status);
  const disclosed = {
    ...analysis,
    dynamicGroups: affected,
    completeness: { ...analysis.completeness, status, exact: status === 'exact', reasons },
  };
  return { ...disclosed, fingerprint: impactFingerprint({ ...disclosed, impacted: [...analysis.impacted, ...affected.map((r) => r.naturalKey)] }) };
}
