import { type ComponentProps, type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CompliancePage } from "@/components/compliance/compliance-page";

// Server-renders the Compliance body at /benchmarks?<search>: the result filter and the
// grouping live in the URL, as on the page.
export async function renderComplianceAt(search: string, props: ComponentProps<typeof CompliancePage>): Promise<string> {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: "/compliance" },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> },
        createElement(CompliancePage, props)))));
}
