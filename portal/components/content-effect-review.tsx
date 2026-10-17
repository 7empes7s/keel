"use client";

import { useRouter } from "next/navigation";

import { ContentEffectsPanel, type ContentEffect } from "@/components/content-effects";
import type { NamedKeys } from "@/lib/job-names";

// Q45: the content-effects panel on its own page; a recorded approval re-reads the page
// so the reviewer sees it bound to exactly these effects.
export function ContentEffectReview(props: {
  artifactId: string;
  effects: ContentEffect[];
  effectsDigest: string | null;
  approvals: { approvedBy: string; approvedAt: string | null }[];
  canApprove: boolean;
  names: NamedKeys;
}) {
  const router = useRouter();
  return <ContentEffectsPanel {...props} onApproved={() => router.refresh()} />;
}
