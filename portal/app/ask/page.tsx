import { connection } from "next/server";

import { AskView } from "@/components/ask-view";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { askInputFrom, askVerdict, type AskData } from "@/lib/ask-view";
import { getAskData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Ask about changes, backup coverage or failed jobs. Every answer comes from KEEL's own records and names them.";

type SearchParams = Record<string, string | string[] | undefined>;

// Roadmap task-99: bounded, grounded questions. Reading needs `read`, centrally or for
// an entity; the guard runs before any loader, and the engine applies the reader's
// entities in its SQL. Asking is a GET: nothing on this page can change anything.
export default async function AskPage({ searchParams }: { searchParams?: Promise<SearchParams> } = {}) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.askPage);
  const params = (await searchParams) ?? {};
  const input = askInputFrom(params);
  let data: AskData;
  try {
    data = await getAskData(access.scope, input);
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Activity" title="Ask" /><DataUnavailable surface="Answers" /></>;
  }
  const verdict = askVerdict(data.answer);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Activity" title="Ask" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <AskView data={data} question={input?.question ?? ""} />
      </div>
    </>
  );
}
