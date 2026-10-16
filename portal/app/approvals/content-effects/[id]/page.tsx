import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { ContentEffectReview } from "@/components/content-effect-review";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import {
  type ContentEffectReviewView,
  contentEffectVerdict,
  getContentEffectReview,
  isArtifactId,
  requireContentEffectReviewAccess,
} from "@/lib/content-effect-review";
import { formatTimestamp } from "@/lib/presentation";

const TITLE = "Content effects";
const DESCRIPTION = "Changes in a dry run that shorten retention, release a hold, widen sharing or destroy content need their own approval.";

// Q45: opened from the approval inbox or from a restore's refusal, for a dry run made
// in the portal or with the command line alike.
export default async function ContentEffectsPage({ params }: { params: Promise<{ id: string }> }) {
  // Guard first: only tenant-wide approvers reach the loader.
  const viewerId = await requireContentEffectReviewAccess();
  await connection();
  const { id } = await params;
  if (!isArtifactId(id)) notFound();

  let review: ContentEffectReviewView | null = null;
  try {
    review = await getContentEffectReview(id, viewerId);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Inbox" title={TITLE} />
        <DataUnavailable surface="These content effects" />
      </>
    );
  }
  if (!review) notFound();

  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={new Date().toISOString()} section="Inbox" title={TITLE} />
      <Verdict text={contentEffectVerdict(review)} tone={review.effects.length === 0 || review.approvals.length > 0 ? "good" : "attention"} />
      <Link className="text-link back-link" href="/approvals"><span aria-hidden="true">←</span> All approvals</Link>
      <section aria-labelledby="content-effects-plan-heading" className="report-section">
        <h2 id="content-effects-plan-heading">The dry run</h2>
        <p>
          A restore of {review.resources} {review.resources === 1 ? "resource" : "resources"}, planned{" "}
          <time dateTime={review.createdAt ?? undefined}>{formatTimestamp(review.createdAt)}</time>, asked for by {review.requestedByName}.
          {" "}An approval here covers exactly the effects listed. If the dry run is planned again with different effects, it no longer counts.
        </p>
        <ContentEffectReview
          approvals={review.approvals}
          artifactId={review.artifactId}
          canApprove={!review.viewerIsRequester}
          effects={review.effects}
          effectsDigest={review.effectsDigest}
        />
      </section>
    </>
  );
}
