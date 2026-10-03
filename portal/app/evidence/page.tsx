import { redirect } from "next/navigation";
import { connection } from "next/server";

import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

// Roadmap task-130: the audit record now lives in the Activity timeline, with the same
// filters. The read guard still runs first.
export default async function EvidencePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.evidencePage);
  const input = await searchParams;
  const query = new URLSearchParams({ show: "records" });
  for (const key of ["kind", "from", "to", "before"]) {
    if (typeof input[key] === "string" && input[key]) query.set(key, input[key]);
  }
  redirect(`/activity?${query}`);
}
