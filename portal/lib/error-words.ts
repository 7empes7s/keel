// Plain words for a raw error (engine, Microsoft Graph, a webhook or ServiceNow).
// The portal never shows raw error text in plain view: it shows `cause` and `todo`,
// and the raw text only behind "Show details" (components/ui/error-notice.tsx).

export interface PlainError {
  /** What went wrong, in a short sentence a non-expert understands. */
  cause: string;
  /** The next step, one short sentence. */
  todo: string;
  /** The full raw text for "Show details"; null when there is none. */
  raw: string | null;
}

export interface PlainErrorOptions {
  /** Who answered, for the cause sentence. Default "Microsoft 365". */
  service?: string;
}

interface Rule {
  test: RegExp;
  cause: (service: string) => string;
  todo: (service: string) => string;
}

// First match wins, so the most specific causes come first.
const RULES: Rule[] = [
  {
    test: /\b429\b|throttl|too many requests|rate.?limit/i,
    cause: (service) => `${service} was busy and asked Keel to slow down.`,
    todo: () => "Nothing to do now: the next run tries again. If it keeps happening, space out the schedules.",
  },
  {
    // Exchange refused one mailbox while the others read fine (engine/content/collectors.mjs).
    test: /refused access to this mailbox only/i,
    cause: (service) => `${service} refused Keel access to one mailbox, while the others read fine.`,
    todo: () => "Check whether an application access policy or mailbox restriction leaves it out. Until then it is not backed up.",
  },
  {
    test: /\b(401|403)\b|authorization_requestdenied|forbidden|unauthori[sz]ed|insufficient privileges|not enough rights|access (is )?denied|missing (a )?(permission|grant|role)/i,
    cause: (service) => `Keel's app is missing a permission ${service} asked for.`,
    todo: () => "Check the app's permissions on the Setup page, then try again.",
  },
  {
    test: /\b(410)\b|address was removed|no longer exists|webhook.*(gone|removed|deleted)/i,
    cause: (service) => `The ${service} address no longer works.`,
    todo: () => "Make a new address, add it as a new channel, then turn this one off.",
  },
  {
    test: /\b404\b|not ?found|does not exist/i,
    cause: (service) => `What Keel asked for no longer exists in ${service}.`,
    todo: () => "Check whether it was deleted on purpose. If it was, there is nothing to do.",
  },
  {
    test: /timed? ?out|timeout|did not answer|no answer|econn|etimedout|enotfound|socket hang up|network|unreachable|could not reach/i,
    cause: (service) => `${service} did not answer in time.`,
    todo: () => "Nothing to do now: Keel tries again. If it keeps failing, check that the service is up.",
  },
  {
    test: /\b5\d\d\b|service unavailable|internal server error|bad gateway/i,
    cause: (service) => `${service} had a temporary fault.`,
    todo: () => "Nothing to do now: the next run tries again.",
  },
  {
    test: /\b(400|409|422)\b|would not accept|rejected|refused|invalid|bad request|conflict/i,
    cause: (service) => `${service} would not accept what Keel sent.`,
    todo: () => "Open the details to see what it refused, fix that, then try again.",
  },
  {
    test: /deferred|waiting for|retry on next/i,
    cause: () => "It waited for a complete backup first.",
    todo: () => "Nothing to do: it runs after the next good backup.",
  },
];

const FALLBACK: Omit<Rule, "test"> = {
  cause: () => "It stopped with an error.",
  todo: () => "Try again. If it fails again, share the details with whoever runs Keel.",
};

/** The raw text of an error value, trimmed; null when there is nothing to show. */
export function rawErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  const text = typeof error === "string" ? error : typeof error === "object" ? JSON.stringify(error) : String(error);
  return text.trim() || null;
}

// The engine's sentence for a settings file it can't read (engine/config/configFile.mjs):
// "Keel can't read the <what> file (<path>): <problem>. <next step>." The path stays in
// the details; the plain words keep which file, what is wrong and what to do.
const CONFIG_FILE_PATTERN = /Keel can't read the ([^()\n]+?) file \([^)\n]*\): ([^.\n]+)\. (Fix the file[^\n]*?\.)(?=\s|\\|"|$)/;

/**
 * Plain words for a settings file on the Keel server that could not be read, or null
 * when the error is about something else. Checked before every other rule: the stack
 * that follows the engine's sentence holds line numbers that could read as HTTP codes.
 */
export function settingsFileWords(raw: string | null): Pick<PlainError, "cause" | "todo"> | null {
  if (!raw) return null;
  const file = CONFIG_FILE_PATTERN.exec(raw);
  if (file) return { cause: `Keel can't read the ${file[1]} file: ${file[2]}.`, todo: file[3] };
  // Raw text from before the engine named the file: only a missing file under /etc/keel,
  // never any ENOENT (a missing program or content blob) or JSON error (an HTML answer).
  if (/\bENOENT\b[^\n]*\/etc\/keel\/[^\s'"]+\.json/.test(raw)) {
    return { cause: "A settings file Keel needs on its server is missing.", todo: "Ask whoever runs Keel to put the file named in the details back, then try again." };
  }
  return null;
}

/** A raw error as a plain cause and next step, with the raw text kept for details. */
export function plainError(error: unknown, options: PlainErrorOptions = {}): PlainError {
  const raw = rawErrorText(error);
  const file = settingsFileWords(raw);
  if (file) return { ...file, raw };
  const service = options.service ?? "Microsoft 365";
  const rule = raw ? RULES.find((candidate) => candidate.test.test(raw)) ?? FALLBACK : FALLBACK;
  return { cause: rule.cause(service), todo: rule.todo(service), raw };
}

/** Plain words for a refused portal request, by its HTTP status (0: no answer). The
 *  server's own text goes behind "Show details". */
export function refusalWords(status: number): Pick<PlainError, "cause" | "todo"> {
  if (status === 0) return { cause: "Keel could not be reached.", todo: "Check your connection, then try again." };
  if (status === 401 || status === 403) return { cause: "You need the right role for that, or your sign-in has ended.", todo: "Sign in again. If it still fails, ask an admin for the role." };
  if (status === 404) return { cause: "It no longer exists.", todo: "Reload the page to see where things stand." };
  if (status === 409) return { cause: "Someone else changed it first, or it was already done.", todo: "Reload the page to see where it stands." };
  if (status === 400 || status === 422) return { cause: "Keel would not accept what was sent.", todo: "Open the details to see what it refused, fix that, then try again." };
  return { cause: "Keel could not do that just now.", todo: "Try again in a minute. If it fails again, share the details with whoever runs Keel." };
}

/** Text that looks like a raw error: status codes, exception names, API paths. Used by
 *  the checks that keep raw error text out of plain view. */
export const RAW_ERROR_PATTERN = /\b(Graph|HTTP)\s?[1-5]\d\d\b|\b[A-Z][A-Za-z]*(Error|Exception):|Authorization_Request|throttled after|(?<![\w.])\/(deviceManagement|groups|users|identity|policies|teams)\/|\bE(CONN\w*|TIMEDOUT|NOTFOUND)\b|\bsys_id\b|\b[a-z]+(_[a-z]+)+:\s/;
