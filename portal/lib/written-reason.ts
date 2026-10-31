// One minimum-quality rule for every reason, note and evidence field a person writes:
// a record that says "x", "BECAUSE" or "TEST-UX-001" proves nothing to an auditor.
// Pure and client-safe: forms use it to warn as the person types, and the server
// routes use it again so a request sent without the form is held to the same rule.

export const REASON_MIN_LENGTH = 10;
export const REASON_MAX_LENGTH = 1000;

// Words that carry no meaning on their own. A reason made only of these (plus short
// words and numbers) is a placeholder, however long it is.
const PLACEHOLDER_WORDS = new Set([
  "abc", "asd", "asdf", "asdfg", "asdfgh", "bar", "baz", "because", "blah", "dummy", "fine", "foo", "idk",
  "ipsum", "lol", "lorem", "nah", "none", "nope", "nothing", "okay", "placeholder", "qwe", "qwerty", "reason",
  "sample", "stuff", "tbc", "tbd", "temp", "test", "tested", "testing", "tests", "thing", "things", "todo",
  "whatever", "why", "xxx", "xyz", "yes", "yep", "yup",
]);

const EMPTY = "Write why. It is kept with the record.";
const PLACEHOLDER = "Say what happened in a few real words. Placeholders such as “x”, “test” or “because” are not kept.";
const TOO_SHORT = `Write a little more: at least ${REASON_MIN_LENGTH} characters and two real words.`;
const TOO_LONG = `Keep it under ${REASON_MAX_LENGTH.toLocaleString("en-GB")} characters.`;

export type WrittenProblem = "empty" | "too_short" | "placeholder" | "too_long";

const MESSAGES: Record<WrittenProblem, string> = {
  empty: EMPTY, too_short: TOO_SHORT, placeholder: PLACEHOLDER, too_long: TOO_LONG,
};

export function writtenProblemMessage(problem: WrittenProblem): string {
  return MESSAGES[problem];
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** A word: three or more letters, not one letter repeated ("xxx", "aaaa"). */
function meaningful(word: string): boolean {
  const letters = word.replace(/\p{N}/gu, "");
  return letters.length >= 3 && !/^(.)\1+$/u.test(letters);
}

const placeholderWord = (word: string) => PLACEHOLDER_WORDS.has(word) || PLACEHOLDER_WORDS.has(word.replace(/\p{N}/gu, ""));

/** A link to where the proof is held: http(s) with a dotted host. */
export function isEvidenceLink(text: string): boolean {
  if (!/^https?:\/\//i.test(text) || /\s/.test(text)) return false;
  try {
    const url = new URL(text);
    return /^[^.]+\.[^.]+/.test(url.hostname) && !/^(example|test|localhost)\b/i.test(url.hostname);
  } catch {
    return false;
  }
}

/** What is wrong with a written reason, or null when it is good enough to keep. */
export function reasonProblem(value: unknown): WrittenProblem | null {
  if (typeof value !== "string" || value.trim().length === 0) return "empty";
  const text = value.trim();
  if (text.length > REASON_MAX_LENGTH) return "too_long";
  const all = words(text);
  // Scripts written without spaces count by character: four or more is a phrase.
  const ideographs = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  if (ideographs >= 4) return null;
  // Two different words, at least one of them not a placeholder: "quarterly test"
  // is kept, "test test" and "TEST-UX-001" are not.
  const real = [...new Set(all.filter(meaningful))];
  const onlyPlaceholders = real.every(placeholderWord);
  if (real.length >= 2 && !onlyPlaceholders && text.length >= REASON_MIN_LENGTH) return null;
  if (all.some(placeholderWord) && onlyPlaceholders) return "placeholder";
  if (real.length === 0 && text.length >= REASON_MIN_LENGTH) return "placeholder";
  return "too_short";
}

/** The plain-language message for a reason, or null when it is fine. */
export function reasonMessage(value: unknown): string | null {
  const problem = reasonProblem(value);
  return problem ? MESSAGES[problem] : null;
}

/**
 * Same rule for a field that may be left empty: empty is fine, but text that is
 * written must be a real reason.
 */
export function optionalReasonMessage(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) return null;
  return reasonMessage(value);
}

// Ticket numbers such as CHG-5120, INC0012345 or SR#4471: letters, then digits.
const TICKET = /^[\p{L}]{2,}[-_#/ ]?\d{3,}[\p{L}\p{N}\-_/#.]*$/u;

const EVIDENCE_EMPTY = "Say where the proof is kept: a ticket number or a link.";
const EVIDENCE_TICKET = "Use the ticket number from your ticket system, such as CHG-5120, or a link to it.";
const EVIDENCE_LINK = "Paste the full link to the proof, starting with https://.";
const EVIDENCE_LOG = "Name the log query or record that shows it, such as a search id or a full link.";

/**
 * Evidence that a manual restore step was done. A ticket must look like a ticket
 * number, a link must be a real link, a log reference must name a record, and an
 * attestation is a written statement held to the reason rule.
 */
export function evidenceMessage(type: unknown, reference: unknown): string | null {
  if (typeof reference !== "string" || reference.trim().length === 0) return EVIDENCE_EMPTY;
  const text = reference.trim();
  if (text.length > 500) return "Keep the reference under 500 characters.";
  const placeholder = words(text).some(placeholderWord);
  switch (type) {
    case "ticket":
      if (isEvidenceLink(text)) return null;
      return TICKET.test(text) && !placeholder ? null : EVIDENCE_TICKET;
    case "link":
      return isEvidenceLink(text) && !placeholder ? null : EVIDENCE_LINK;
    case "log-reference":
      if (isEvidenceLink(text)) return null;
      return text.length >= 6 && /\d/.test(text) && /\p{L}/u.test(text) && !placeholder ? null : EVIDENCE_LOG;
    case "attestation":
      return reasonMessage(text);
    default:
      return null;
  }
}

/**
 * Refused by the server: the written text is too weak to keep. The guard answers
 * 400 with `{ error: "weak_reason", field, message }`, so the form can show it.
 */
export class WeakReasonError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "WeakReasonError";
  }
}

/**
 * Throws WeakReasonError when `value` is written but too weak to keep. A missing
 * reason is left to the caller's own required check, so a request for something
 * that does not exist, or that the caller may not touch, is still answered first.
 */
export function refuseWeakReason<T>(value: T, field = "reason"): T {
  if (typeof value === "string" && value.trim().length > 0) {
    const message = reasonMessage(value);
    if (message) throw new WeakReasonError(field, message);
  }
  return value;
}

/** Throws unless `value` is empty or a good reason. Returns it trimmed, or null. */
export function requireOptionalReason(value: unknown, field = "reason"): string | null {
  const message = optionalReasonMessage(value);
  if (message) throw new WeakReasonError(field, message);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
