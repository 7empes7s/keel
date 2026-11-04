import { kindOfRecord } from "@/lib/activity-view";
import { isDay } from "@/lib/date-range";

// Pages that were merged into others keep their old address as a redirect (roadmap
// task-130 and task-131). The server pages and the UI harness both read the target
// from here, so the harness checks the page a person actually lands on.
export const OLD_ROUTE_TARGETS = {
  "/backups": "/protect",
  "/coverage": "/protect",
  "/jobs": "/activity?show=jobs",
} as const;

type Params = Record<string, string | string[] | undefined>;

/** Where an old /evidence address goes: the Activity records, its filters renamed. */
export function evidenceTarget(input: Params): string {
  const value = (key: string) => (typeof input[key] === "string" && input[key] ? String(input[key]) : null);
  const query = new URLSearchParams({ show: "records" });
  if (value("kind")) query.set("what", kindOfRecord(value("kind")!));
  const from = value("from")?.slice(0, 10);
  const to = value("to")?.slice(0, 10);
  if (from && isDay(from)) query.set("range", to && isDay(to) && to !== from ? `${from}..${to}` : from);
  if (value("before")) query.set("before", value("before")!);
  return `/activity?${query}`;
}
