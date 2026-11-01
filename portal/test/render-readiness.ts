import { type ComponentProps, type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReadinessPage } from "@/components/readiness/readiness-page";

// Server-renders the Emergency access body at /readiness?<search>, the way the page
// does: an open sheet lives in the URL. Sheets are portals, so they are
// covered in Playwright, not here.
export async function renderReadinessAt(search: string, props: ComponentProps<typeof ReadinessPage>): Promise<string> {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as unknown as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: "/emergency-access" },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> },
        createElement(ReadinessPage, props)))));
}
