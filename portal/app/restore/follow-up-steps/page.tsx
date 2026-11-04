import { connection } from "next/server";
import { headers } from "next/headers";

import { PageHeader } from "@/components/page-header";
import { RestoreFollowUps } from "@/components/restore-follow-ups";
import { Verdict } from "@/components/verdict";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getRestoreFollowUps } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { OpenFollowUpWork } from "@/lib/types";

const TITLE = "Follow-up steps";
const DESCRIPTION = "Work a restore leaves for a person, such as a new secret, a consent or a service check. Open a restore to finish its steps.";

// Restore › Follow-up steps: every restore with steps still open, however old. Overview,
// Resilience and the Restore settings alert link here (engine OPEN_COMPLETION_HREF).
export default async function RestoreFollowUpStepsPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.restoreFollowUpsPage);
  const canRestore = ((await headers()).get(CAPABILITIES_HEADER) ?? "").split(" ").includes("restore");
  let work: OpenFollowUpWork | null;
  try {
    work = await getRestoreFollowUps();
  } catch {
    work = null;
  }
  const now = new Date().toISOString();
  const steps = work?.steps ?? 0;
  const restores = work?.restores ?? 0;

  return (
    <>
      <PageHeader
        description={DESCRIPTION}
        generatedAt={now}
        section="Restore"
        status={work === null ? undefined : steps ? { tone: "soon", label: `${steps} open` } : { tone: "fine", label: "All done" }}
        title={TITLE}
      />
      {work === null ? (
        <p className="action-error">KEEL could not read the follow-up steps restores left open. Reload in a minute.</p>
      ) : (
        <>
          <Verdict
            text={steps
              ? `${steps} ${steps === 1 ? "step is" : "steps are"} still open from ${restores === 1 ? "1 restore" : `${restores} restores`}. Open each restore to finish them.`
              : "Nothing to finish: no restore is waiting on a step by hand."}
            tone={steps ? "soon" : "fine"}
          />
          <div data-layer="explanation">
            <RestoreFollowUps canRestore={canRestore} now={now} work={work} />
          </div>
        </>
      )}
    </>
  );
}
