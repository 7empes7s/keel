import { type ComponentProps, type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SchedulesPage } from "@/components/schedules/schedules-page";

// Server-renders the Schedules body at /schedules?<search>, the way the page does: the
// filter, the grouping and the open panel live in the URL. The panel is a portal, so
// it is covered in Playwright, not here.
export async function renderSchedulesAt(search: string, props: ComponentProps<typeof SchedulesPage>): Promise<string> {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: { refresh() {} } as unknown as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: "/schedules" },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> },
        createElement(SchedulesPage, props)))));
}
