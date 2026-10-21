import { type ComponentProps, type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NotificationsPage } from "@/components/notifications/notifications-page";

// Server-renders the Notifications body at /notifications?<search>, the way the page
// does: the tab, the open channel or rule and the filters live in the URL.
export async function renderNotificationsAt(search: string, props: ComponentProps<typeof NotificationsPage>): Promise<string> {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: "/notifications" },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> },
        createElement(NotificationsPage, props)))));
}
