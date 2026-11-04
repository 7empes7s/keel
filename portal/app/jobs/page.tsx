import { redirect } from "next/navigation";
import { connection } from "next/server";

import { OLD_ROUTE_TARGETS } from "@/lib/old-routes";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

// Roadmap task-130: job history now lives in the Activity timeline. The read guard
// still runs first, so an unauthorized request is refused, never redirected.
export default async function JobsPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.jobsPage);
  redirect(OLD_ROUTE_TARGETS["/jobs"]);
}
