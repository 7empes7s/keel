// How a record field's value reads in the "Technical details" panel: plain words, a
// colour for status values, and the stored value kept for support. Pure, so the unit
// tests and server components can use it.
import type { FieldInfo } from "@/lib/record-glossary";
import { valueLines } from "@/lib/changed-values";
import { DISPLAY_ENUMS, formatTimestamp, words } from "@/lib/presentation";

export type ValueTone = "urgent" | "soon" | "fine" | "neutral";

export type ShownValue =
  | { kind: "missing"; text: string; tone: ValueTone; why: string | null }
  | { kind: "text"; text: string; tone: ValueTone | null; cut: boolean }
  | { kind: "lines"; lines: { label: string; text: string }[]; more: number }
  | { kind: "error"; line: string; full: string; cut: boolean };

/** The longest plain value shown in full; longer ones are cut, the rest is in support details. */
export const MAX_PLAIN = 160;
const MAX_ERROR_LINE = 140;

const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const CODE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const CAMEL = /^[a-z]+(?:[A-Z][a-z0-9]+)+$/;

const BAD = new Set(["failed", "fail", "fails", "failure", "error", "errored", "refused", "rejected", "broken", "denied", "blocked", "unreachable", "timeout", "timed-out", "critical", "irrecoverable", "invalid", "expired", "revoked", "quarantined", "compromised", "unsafe", "not-covered", "unprotectable", "missing", "absent-required", "tenant-lockout", "urgent", "fail-closed"]);
const WARN = new Set(["unmeasured", "stale", "pending", "partial", "partially-protected", "queued", "running", "retrying", "unknown", "not-checked", "unchecked", "degraded", "warning", "waiting", "paused", "disabled", "skipped", "incomplete", "open", "reopened", "needs-attention", "attention", "unverified", "not-proven", "fixture-tested", "access-affecting", "acknowledged", "in-progress", "delivering", "held", "read-only", "ongoing", "draft", "superseded", "cancelled", "canceled", "not-run", "not-measured", "unsupported", "excluded", "limited"]);
const GOOD = new Set(["succeeded", "success", "successful", "ok", "pass", "passed", "passes", "verified", "complete", "completed", "healthy", "fresh", "current", "covered", "enabled", "active", "approved", "matched", "matches", "resolved", "good", "recovered", "protected", "valid", "delivered", "proven", "live-qualified", "cleared", "closed", "done", "finished", "ready", "settled", "authorized", "qualified", "measured", "restored", "within-target", "none-open"]);

const MISSING_WORDS: Record<string, string> = {
  unmeasured: "Not measured yet",
  "not measured": "Not measured yet",
  none: "None",
  "not set": "Not set",
  "not kept": "Not kept",
  "n/a": "Does not apply",
  never: "Never",
  unknown: "Not known",
  missing: "Missing",
};

function toneOf(word: string): ValueTone | null {
  const key = word.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (BAD.has(key)) return "urgent";
  if (WARN.has(key)) return "soon";
  if (GOOD.has(key)) return "fine";
  return null;
}

/** "partially-protected" → "Partially protected"; other text unchanged. */
export function codeWords(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 40 && (CODE.test(trimmed) || CAMEL.test(trimmed))) return words(trimmed.replaceAll("_", "-"));
  return text;
}

/** 90061000 → "1 day 1 hour"; 450 → "450 ms". */
export function durationWords(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return String(ms);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1).replace(/\.0$/, "") : Math.round(seconds)} seconds`;
  const minutes = Math.round(seconds / 60);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${plural(hours, "hour")} ${plural(minutes % 60, "minute")}` : plural(hours, "hour");
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${plural(days, "day")} ${plural(hours % 24, "hour")}` : plural(days, "day");
}

export function bytesWords(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return unit === 0 ? `${new Intl.NumberFormat("en-GB").format(value)} bytes` : `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function numberWords(value: number, info: FieldInfo | null): string {
  switch (info?.format) {
    case "duration-ms": return durationWords(value);
    case "duration-s": return durationWords(value * 1000);
    case "bytes": return bytesWords(value);
    default: return new Intl.NumberFormat("en-GB").format(value);
  }
}

function isMissing(value: unknown): value is null | undefined | string {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string") return false;
  const text = value.trim().toLowerCase();
  return text === "" || text in MISSING_WORDS;
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function cut(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) return { text, cut: false };
  const at = text.lastIndexOf(" ", limit);
  return { text: `${text.slice(0, at > limit * 0.6 ? at : limit).trimEnd()}…`, cut: true };
}

/** The plain-words version of a string: dates, codes and "a · b" lists in words; a
 *  field with an enum group reads its stored codes through that group. */
export function plainText(value: string, info: FieldInfo | null = null): string {
  const names = info?.enum ? (DISPLAY_ENUMS[info.enum] as Record<string, string>) : null;
  if (/^\d{4}-\d{2}-\d{2}T[^ ]*$/.test(value.trim())) {
    const formatted = formatTimestamp(value.trim());
    if (formatted !== "Invalid timestamp") return formatted;
  }
  return value
    .replace(ISO, (match) => {
      const formatted = formatTimestamp(match);
      return formatted === "Invalid timestamp" ? match : formatted;
    })
    .split(" · ")
    .map((part) => names?.[part.trim()] ?? codeWords(part))
    .join(" · ");
}

/** How one field's value reads for a person. */
export function shownValue(value: unknown, info: FieldInfo | null): ShownValue {
  if (info?.error) {
    if (isMissing(value)) return { kind: "missing", text: "No error", tone: "fine", why: null };
    const full = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? String(value);
    const first = full.split("\n").find((line) => line.trim()) ?? full;
    const line = cut(first.trim(), MAX_ERROR_LINE);
    return { kind: "error", line: line.text, full, cut: line.cut || full.trim() !== first.trim() };
  }
  if (isMissing(value)) {
    const key = typeof value === "string" ? value.trim().toLowerCase() : "";
    const text = MISSING_WORDS[key] ?? "None";
    return { kind: "missing", text, tone: key === "unmeasured" || key === "not measured" ? "soon" : "neutral", why: info?.missing ?? null };
  }
  if (typeof value === "boolean" || value === "true" || value === "false") {
    const yes = value === true || value === "true";
    const tone: ValueTone | null = info?.goodWhen === undefined ? null : yes === info.goodWhen ? "fine" : "soon";
    return { kind: "text", text: yes ? "Yes" : "No", tone, cut: false };
  }
  if (typeof value === "number") {
    const tone: ValueTone | null = info?.zeroIsGood ? (value === 0 ? "fine" : "soon") : null;
    return { kind: "text", text: numberWords(value, info), tone, cut: false };
  }
  if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) && info?.format) {
    return shownValue(Number(value), info);
  }
  const structured = typeof value === "object" ? value : typeof value === "string" ? parseJson(value) : undefined;
  if (structured !== undefined) {
    const { lines, more } = valueLines(structured, {}, 6);
    if (lines.length === 1 && !lines[0].label && !more) return { kind: "text", text: lines[0].text, tone: null, cut: false };
    return { kind: "lines", lines: lines.map((line) => ({ label: line.label, text: cut(line.text, 80).text })), more };
  }
  const text = String(value);
  const firstLine = text.split("\n")[0];
  const shown = cut(plainText(firstLine, info), MAX_PLAIN);
  const tone = toneOf(text.split(" · ")[0].split(" ")[0].replace(/[,.;:]$/, "")) ?? toneOf(text.split(" · ")[0]);
  return { kind: "text", text: shown.text, tone, cut: shown.cut || firstLine !== text };
}
