import { guardedAction } from "@/lib/action";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Run now on the Schedules page. Read-only for the tenant; the capability comes from
// engine/authz/jobCapabilities.mjs. It takes no parameters: the job always runs on the
// server's own config files, never on paths from the request.
export const POST = guardedAction({
  action: "content-collect",
  jobKind: "content-collect",
  requiresApproval: false,
  acceptsParams: false,
});
