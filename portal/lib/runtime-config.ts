import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const DEFAULT_DB_ENV_PATH = "/etc/keel/db.env";
const DEFAULT_TENANT_CONFIG_PATH = "/etc/keel/tenant.json";

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function envValueFromFile(path: string, key: string): string | null {
  const contents = readFileSync(/* turbopackIgnore: true */ path, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)\s*$/);
    if (match?.[1] === key) {
      return unquote(match[2].trim());
    }
  }

  return null;
}

export function databaseUrl(): string {
  const configured =
    process.env.KEEL_DB_URL ??
    envValueFromFile(
      process.env.KEEL_DB_ENV_PATH ?? DEFAULT_DB_ENV_PATH,
      "KEEL_DB_URL",
    );

  if (!configured) {
    throw new Error("KEEL_DB_URL is not configured");
  }

  return configured;
}

export function tenantRef(): string {
  const configPath =
    process.env.KEEL_TENANT_CONFIG_PATH ?? DEFAULT_TENANT_CONFIG_PATH;
  const config = JSON.parse(
    readFileSync(/* turbopackIgnore: true */ configPath, "utf8"),
  ) as {
    tenantId?: unknown;
  };

  if (typeof config.tenantId !== "string" || config.tenantId.length === 0) {
    throw new Error("tenant config has no tenantId");
  }

  const digest = createHash("sha256").update(config.tenantId).digest("hex");
  return `sha256:${digest.slice(0, 16)}`;
}

// Plan task 14 step 5: approval requests expire after a configurable TTL. Unset means
// the engine default (engine/govern/approvals.mjs DEFAULT_APPROVAL_TTL_MS) applies.
export function approvalTtlMs(): number | undefined {
  const configured = process.env.KEEL_APPROVAL_TTL_MS;
  if (configured === undefined || configured.trim() === "") return undefined;

  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("KEEL_APPROVAL_TTL_MS must be a positive number of milliseconds");
  }
  return parsed;
}

// Roadmap task-110: the time zone the Schedules page uses to say which upcoming runs
// fall in business hours. Display only; schedules are stored and run in UTC.
export function businessTimeZone(): string {
  const configured = process.env.KEEL_BUSINESS_TIME_ZONE?.trim();
  return configured ? configured : "UTC";
}

// Roadmap task-87: the recovery manifest written by ops/keel-dump-manifest.mjs
// --recovery, whose residency names where backups are stored. Unset means the
// storage location is reported as not configured.
export function recoveryManifestPath(): string | null {
  const configured = process.env.KEEL_RECOVERY_MANIFEST_PATH;
  return configured && configured.length > 0 ? configured : null;
}
