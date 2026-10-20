import { headers } from "next/headers";
import { forbidden } from "next/navigation";

import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { loadContentEffectReview } from "../../engine/safety/contentEffects.mjs";
import { connect } from "../../engine/store/db.mjs";

import type { ContentEffect } from "@/components/content-effects";
import { approvalInboxScope } from "@/lib/approval-inbox";
import type { NamedKeys } from "@/lib/job-names";
import { PRINCIPAL_ID_HEADER } from "@/lib/principal";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { savedNames } from "@/lib/saved-names";
import { type EngineRef, personLabel } from "@/lib/sentences";

// Q45: the content effects of ANY persisted dry run, whichever surface made it (the
// portal, or `keel-restore --persist-artifact` from the command line), shown to the
// people who can approve them. The approval itself is the existing route
// (/api/actions/restore/content-effects), which requires tenant-wide approve and
// refuses the requester; this page admits exactly that audience, before any loader.

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface HeaderSource {
  get(name: string): string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isArtifactId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** The viewer's principal id when they hold tenant-wide approve; null otherwise. */
export function contentEffectReviewAccess(requestHeaders: HeaderSource): string | null {
  const scope = approvalInboxScope(requestHeaders);
  if (!scope?.central) return null;
  return requestHeaders.get(PRINCIPAL_ID_HEADER);
}

export async function requireContentEffectReviewAccess(): Promise<string> {
  const principalId = contentEffectReviewAccess(await headers());
  if (!principalId) forbidden();
  return principalId;
}

export interface ContentEffectReviewView {
  artifactId: string;
  status: string;
  resources: number;
  createdAt: string | null;
  requestedByName: string;
  viewerIsRequester: boolean;
  effects: ContentEffect[];
  effectsDigest: string | null;
  approvals: { approvedBy: string; approvedAt: string | null }[];
  // Saved names by key, so each effect names its object, never by id.
  names: NamedKeys;
}

export interface EngineContentEffectReview {
  artifactId: string;
  requestedBy: string | null;
  status: string;
  createdAt: unknown;
  resources: number;
  effects: ContentEffect[];
  effectsDigest: string | null;
  approvals: { approvedBy: string; approvedAt: unknown }[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/** Builds the page's view: people by name, never by id. Pure, so it is tested directly. */
export function contentEffectReviewView(
  review: EngineContentEffectReview,
  people: Map<string, EngineRef>,
  viewerId: string,
  names: NamedKeys = {},
): ContentEffectReviewView {
  const nameOf = (id: string | null) => personLabel(id ? people.get(id) : null);
  return {
    artifactId: review.artifactId,
    status: review.status,
    resources: review.resources,
    createdAt: iso(review.createdAt),
    requestedByName: nameOf(review.requestedBy),
    viewerIsRequester: review.requestedBy !== null && String(review.requestedBy) === String(viewerId),
    effects: review.effects,
    effectsDigest: review.effectsDigest,
    approvals: review.approvals.map((approval) => ({ approvedBy: nameOf(approval.approvedBy), approvedAt: iso(approval.approvedAt) })),
    names,
  };
}

/** The page's one-line verdict. Pure, so it is tested directly. */
export function contentEffectVerdict(review: ContentEffectReviewView): string {
  if (review.effects.length === 0) return "This restore changes no kept or shared content. It needs only the usual approval.";
  if (review.approvals.length > 0) return "These content changes are approved. The restore can run once its own request is approved.";
  if (review.viewerIsRequester) return "You asked for this restore, so someone else must approve its content changes.";
  return "This restore changes kept or shared content. It cannot run until you approve those changes.";
}

export async function getContentEffectReview(artifactId: string, viewerId: string): Promise<ContentEffectReviewView | null> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const review = (await loadContentEffectReview(client, { tenantRef: tenantRef(), artifactId })) as EngineContentEffectReview | null;
    if (!review) return null;
    const people = (await resolvePrincipals(client, [review.requestedBy, ...review.approvals.map((approval) => approval.approvedBy)])) as Map<string, EngineRef>;
    const names = await savedNames(client, tenantRef(), review.effects.map((effect) => effect.naturalKey));
    return contentEffectReviewView(review, people, viewerId, names);
  } finally {
    await client.end();
  }
}
