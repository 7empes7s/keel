import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { ContentEffectReview } from "@/components/content-effect-review";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { pageTrail } from "@/lib/page-trail";
import { Verdict } from "@/components/verdict";
import {
  type ContentEffectReviewView,
  contentEffectVerdict,
  getContentEffectReview,
  isArtifactId,
  requireContentEffectReviewAccess,
} from "@/lib/content-effect-review";
import { formatTimestamp } from "@/lib/presentation";

const TITLE = "Changes to kept or shared content";
const PARENTS = [{ href: "/approvals", label: "Approvals" }];
const DESCRIPTION = "A restore that shortens how long content is kept, releases a hold, widens sharing or deletes content needs its own approval.";

// Q45: opened from the approval inbox or from a restore's refusal, for a dry run made
// in the portal or with the command line alike.
export default async function ContentEffectsPage({ params }: { params: Promise<{ id: string }> }) {
  // Guard first: only tenant-wide approvers reach the loader.
  const viewerId = await requireContentEffectReviewAccess();
  await connection();
  const trail = await pageTrail("Inbox", PARENTS);
  const { id } = await params;
  if (!isArtifactId(id)) notFound();

  let review: ContentEffectReviewView | null = null;
  try {
    review = await getContentEffectReview(id, viewerId);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} parents={trail.parents} section={trail.section} title={TITLE} />
        <DataUnavailable surface="These content effects" />
      </>
    );
  }
  if (!review) notFound();
  // Cleared: nothing to approve, already approved, or restore approvals are off for these services.
  const cleared = review.effects.length === 0 || review.approvals.length > 0 || !review.approvalRequired;

  return (
    <>
      <PageHeader
        description={DESCRIPTION}
        generatedAt={new Date().toISOString()}
        parents={trail.parents}
        section={trail.section}
        status={!review.approvalRequired && review.effects.length > 0 ? { tone: "fine", label: "No approval needed" } : cleared ? { tone: "fine", label: "Approved" } : { tone: "soon", label: "Waiting for you" }}
        title={TITLE}
      />
      <Verdict text={contentEffectVerdict(review)} tone={cleared ? "fine" : "soon"} />
      <section aria-labelledby="content-effects-plan-heading" className="report-section ce-section">
        <h2 id="content-effects-plan-heading">The restore</h2>
        <p className="ce-plan">
          Restore of {review.resources} {review.resources === 1 ? "setting" : "settings"}, planned{" "}
          <time dateTime={review.createdAt ?? undefined}>{formatTimestamp(review.createdAt)}</time>, asked for by {review.requestedByName}.
          {review.approvalRequired ? " Your approval covers exactly the changes below." : " Restore approvals are off for these services, so the changes below are made with the restore."}
        </p>
        <ContentEffectReview
          approvals={review.approvals}
          artifactId={review.artifactId}
          canApprove={(!review.viewerIsRequester || review.selfApprovalAllowed === true) && review.approvalRequired}
          effects={review.effects}
          effectsDigest={review.effectsDigest}
          names={review.names}
        />
        <p className="ce-help">Rejecting happens on the restore request itself. To stop the restore, <Link className="ap-inline-link" href="/approvals">reject the request</Link> in Approvals.</p>
      </section>
    </>
  );
}
