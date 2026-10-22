import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

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
// --recovery, whose residency names where backups are stored. Unset, the location is
// read from where Keel's database runs (databaseIsLocal), else reported as not set.
export function recoveryManifestPath(): string | null {
  const configured = process.env.KEEL_RECOVERY_MANIFEST_PATH;
  return configured && configured.length > 0 ? configured : null;
}

// With no recovery manifest, backups are known to sit on this server only when Keel's
// own database (where settings backups are kept) runs here.
const LOCAL_HOSTS = new Set(["", "localhost", "127.0.0.1", "[::1]", "::1"]);

/** True when the database URL names this machine (a loopback host or a local socket). */
export function databaseIsLocal(url: string): boolean {
  // Read by hand: Postgres accepts URLs with an empty host ("postgres://keel@/keel")
  // that the URL parser refuses.
  const match = /^postgres(?:ql)?:\/\/(?:[^@/?]*@)?(\[[^\]]*\]|[^/?:]*)/i.exec(url);
  if (!match) return false;
  const socketHost = /[?&]host=([^&]*)/.exec(url)?.[1];
  if (socketHost !== undefined) {
    const host = decodeURIComponent(socketHost);
    return host.startsWith("/") || LOCAL_HOSTS.has(host.toLowerCase());
  }
  return LOCAL_HOSTS.has(match[1].toLowerCase());
}

// Gap P2: the key that verifies the signed live records in docs/release/qualifications.
// KEEL_QUALIFICATION_HMAC_KEY in the process environment wins; otherwise the same
// variable is read from KEEL_QUALIFICATION_ENV_PATH (default /etc/keel/qualification.env),
// which must be mode 600. A missing key, or a file others can read, verifies nothing.
const DEFAULT_QUALIFICATION_ENV_PATH = "/etc/keel/qualification.env";

export interface QualificationKey {
  key: string | null;
  /** Why a key file that exists is not used, in plain words; null otherwise. */
  problem: string | null;
}

export function qualificationKey(): QualificationKey {
  const fromEnv = process.env.KEEL_QUALIFICATION_HMAC_KEY;
  if (fromEnv && fromEnv.length > 0) return { key: fromEnv, problem: null };

  const path = process.env.KEEL_QUALIFICATION_ENV_PATH ?? DEFAULT_QUALIFICATION_ENV_PATH;
  let mode: number;
  try {
    mode = statSync(/* turbopackIgnore: true */ path).mode;
  } catch {
    return { key: null, problem: null };
  }
  if ((mode & 0o077) !== 0) {
    return { key: null, problem: "the key file can be read by other users, so it is not used; set it to mode 600" };
  }
  try {
    const key = envValueFromFile(path, "KEEL_QUALIFICATION_HMAC_KEY");
    return { key: key && key.length > 0 ? key : null, problem: null };
  } catch {
    return { key: null, problem: "the key file cannot be read by the portal" };
  }
}

// The committed live records. The portal runs from portal/, so the default is the
// repository's docs/release/qualifications; KEEL_LIVE_EVIDENCE_DIR overrides it.
export function liveEvidenceDir(): string {
  const configured = process.env.KEEL_LIVE_EVIDENCE_DIR;
  return configured && configured.length > 0
    ? configured
    : resolve(/* turbopackIgnore: true */ process.cwd(), "..", "docs", "release", "qualifications");
}
