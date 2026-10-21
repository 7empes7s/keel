import { type ComponentProps, type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { IncidentsPage } from "@/components/incidents/incidents-page";

// Server-renders the Incidents body at /incidents?<search>: the state filter, the open
// backup and the grouping live in the URL, as on the page.
export async function renderIncidentsAt(search: string, props: ComponentProps<typeof IncidentsPage>): Promise<string> {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: "/incidents" },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> },
        createElement(IncidentsPage, props)))));
}
