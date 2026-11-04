import { redirect } from "next/navigation";
import { connection } from "next/server";

import { OLD_ROUTE_TARGETS } from "@/lib/old-routes";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

// Roadmap task-131: coverage now lives on Protect. The read guard still runs first, so an
// unauthorized request is refused, never redirected.
export default async function CoveragePage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.coveragePage);
  redirect(OLD_ROUTE_TARGETS["/coverage"]);
}
