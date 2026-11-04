import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { OwnerReviewPage } from "@/components/owner-review-page";
import { PageHeader } from "@/components/page-header";
import { getOwnerReview } from "@/lib/owner-review";
import { ownerReviewStatus, type OwnerReviewData } from "@/lib/owner-review-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Microsoft 365 groups, teams, apps and sites with no working owner: nobody, only disabled accounts, or guests.";

// Owner review (issue #964): read from the newest complete backup's owner reads and
// users, and the nightly backup's site owners. Needs `read`, tenant-wide; the guard runs
// before any loader. Nothing on this page can change anything.
export default async function OwnerReviewRoute() {
  await connection();
  await requireReadAccess(DATA_SURFACES.ownerReviewPage);

  let data: OwnerReviewData;
  try {
    data = await getOwnerReview();
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Baselines" title="Owner review" />
        <DataUnavailable surface="Owner review" />
      </>
    );
  }

  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Baselines" status={ownerReviewStatus(data)} title="Owner review" />
      <OwnerReviewPage data={data} />
    </>
  );
}
