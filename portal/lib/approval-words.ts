// Who approves, in the words of the tenant's approval mode (lib/approval-mode.ts).
// Two people (Keel's default): someone other than the person who asked approves.
// Solo: the person who asked may approve it themselves, with a reason, and it is
// recorded as self-approved. Every portal line that says who approves takes its words
// from here, so no page promises "someone else" while the mode is Solo. A test
// (test/approval-words.test.ts) stops fixed "someone else approves" wording coming back.
// Pure and free of server imports, so client components use it too.

export type ApprovalModeName = "two-person" | "solo";

export interface ApprovalWords {
  solo: boolean;
  /** Follows "once" or "until": "someone else approves" / "it is approved". */
  approves: string;
  /** Follows "needs": "someone else's approval" / "approval, which you can give yourself". */
  approval: string;
  /** A whole sentence: "Nothing changes until someone else approves." */
  untilApproved: string;
  /** The waiting step on a sent restore: "Another person reviews this same plan". */
  reviewStep: string;
  /** Starts a sentence: "A second person approves it" / "An approver approves it (... can be you)". */
  approvesIt: string;
  /** Comes before "approves", mid-sentence: "someone other than the person who asked" / "an approver (...)". */
  approver: string;
  /** Starts a sentence before "approves": "Someone other than you" / "An approver (in Solo mode, you)". */
  planApprover: string;
  /** Follows "was" or "were": "sent to a second person to approve" / "sent for approval". */
  sentFor: string;
}

const TWO_PERSON: ApprovalWords = {
  solo: false,
  approves: "someone else approves",
  approval: "someone else's approval",
  untilApproved: "Nothing changes until someone else approves.",
  reviewStep: "Another person reviews this same plan",
  approvesIt: "A second person approves it",
  approver: "someone other than the person who asked",
  planApprover: "Someone other than you",
  sentFor: "sent to a second person to approve",
};

const SOLO: ApprovalWords = {
  solo: true,
  approves: "it is approved (in Solo mode you can approve it yourself)",
  approval: "approval, which you can give yourself in Solo mode",
  untilApproved: "Nothing changes until it is approved. Approval mode is Solo, so you can approve it yourself, with a reason.",
  reviewStep: "An approver reviews this same plan; in Solo mode that can be you",
  approvesIt: "An approver approves it (in Solo mode, that can be you)",
  approver: "an approver (in Solo mode, that can be the person who asked)",
  planApprover: "An approver (in Solo mode, that can be you)",
  sentFor: "sent for approval (in Solo mode you can approve it yourself)",
};

/** The words for a mode. Unknown or unread reads as two people, Keel's default. */
export function approvalWords(mode: ApprovalModeName | null | undefined): ApprovalWords {
  return mode === "solo" ? SOLO : TWO_PERSON;
}
