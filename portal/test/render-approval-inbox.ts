import { type ComponentProps, type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApprovalInbox } from "@/components/approval-inbox";

// Server-renders the inbox at /approvals?<search>, the way the page does: the view
// state (which list shows, which request is open) lives in the URL.
export async function renderApprovalInboxAt(search: string, props: ComponentProps<typeof ApprovalInbox>): Promise<string> {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: "/approvals" },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> },
        createElement(ApprovalInbox, props)))));
}
