import { redirect } from "next/navigation";
import { connection } from "next/server";

import { evidenceTarget } from "@/lib/old-routes";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

// Roadmap task-130: the audit record now lives in the Activity timeline, with the same
// filters under their new names. The read guard still runs first.
export default async function EvidencePage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  await requireReadAccess(DATA_SURFACES.evidencePage);
  redirect(evidenceTarget(await searchParams));
}
