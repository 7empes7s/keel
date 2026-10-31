"use client";

import { createContext, useContext, type ReactNode } from "react";

import { approvalWords, type ApprovalModeName, type ApprovalWords } from "@/lib/approval-words";

// The tenant's approval mode for every page, read once by the root layout. Pages and
// components that say who approves read it here instead of fixing "someone else".
// Without a provider (or when the mode could not be read) it is two people.

const ApprovalModeContext = createContext<ApprovalModeName>("two-person");

export function ApprovalModeProvider({ mode, children }: { mode: ApprovalModeName | null; children?: ReactNode }) {
  return <ApprovalModeContext.Provider value={mode ?? "two-person"}>{children}</ApprovalModeContext.Provider>;
}

export function useApprovalMode(): ApprovalModeName {
  return useContext(ApprovalModeContext);
}

export function useApprovalWords(): ApprovalWords {
  return approvalWords(useContext(ApprovalModeContext));
}

/** One phrase from the approval words, for server components that cannot read context. */
export function ApprovalText({ phrase }: { phrase: Exclude<keyof ApprovalWords, "solo"> }) {
  return <>{useApprovalWords()[phrase]}</>;
}
