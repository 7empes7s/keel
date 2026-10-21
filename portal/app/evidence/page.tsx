import { redirect } from "next/navigation";
import { connection } from "next/server";

import { kindOfRecord } from "@/lib/activity-view";
import { isDay } from "@/lib/date-range";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

// Roadmap task-130: the audit record now lives in the Activity timeline, with the same
// filters under their new names. The read guard still runs first.
export default async function EvidencePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.evidencePage);
  const input = await searchParams;
  const value = (key: string) => (typeof input[key] === "string" && input[key] ? String(input[key]) : null);
  const query = new URLSearchParams({ show: "records" });
  if (value("kind")) query.set("what", kindOfRecord(value("kind")!));
  const from = value("from")?.slice(0, 10);
  const to = value("to")?.slice(0, 10);
  if (from && isDay(from)) query.set("range", to && isDay(to) && to !== from ? `${from}..${to}` : from);
  if (value("before")) query.set("before", value("before")!);
  redirect(`/activity?${query}`);
}
