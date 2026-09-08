import type { ProtectionState } from "@/lib/types";

export const BLAST_RADIUS_ORDER = [
  "tenant-lockout",
  "access-affecting",
  "cosmetic",
];

export const PROTECTION_STATE_ORDER: ProtectionState[] = [
  "failed",
  "not-covered",
  "unprotectable",
  "partially-protected",
  "read-only",
  "protected",
];

export const PROTECTION_STATE_LABEL: Record<ProtectionState, string> = {
  protected: "Protected",
  "partially-protected": "Partially protected",
  "read-only": "Read-only",
  unprotectable: "Unprotectable",
  failed: "FAILED",
  "not-covered": "Not covered",
};

export function words(value: string | null): string {
  if (!value) return "Unknown";
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])/g, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

export function formatTimestamp(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Invalid timestamp";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date) + " UTC";
}

export function formatAge(value: string | null, now = new Date()): string {
  if (!value) return "No recorded time";
  const date = new Date(value);
  const milliseconds = now.valueOf() - date.valueOf();
  if (!Number.isFinite(milliseconds)) return "Invalid time";
  if (milliseconds < 0) return "In the future";

  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "Less than a minute old";
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h old`;
  return `${Math.floor(hours / 24)}d old`;
}

export function adapterSurface(adapter: string | null): string {
  if (!adapter) return "No serving adapter";
  if (adapter.startsWith("graph-")) return "Microsoft Graph";
  if (adapter.startsWith("powershell")) return "PowerShell";
  if (adapter.startsWith("dsc")) return "DSC";
  return "Adapter";
}
