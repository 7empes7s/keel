import { connection } from "next/server";

import { PageHeader } from "@/components/page-header";
import { RestoreFollowUps, followUpTotals } from "@/components/restore-follow-ups";
import { Verdict } from "@/components/verdict";
import { getRestoreFollowUps } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { RestoreFollowUp } from "@/lib/types";

const TITLE = "Follow-up steps";
const DESCRIPTION = "Work a restore leaves for a person, such as a new secret, a consent or a service check. Open a restore to finish its steps.";

// Restore › Follow-up steps: every restore with steps still open, however old.
export default async function RestoreFollowUpsPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.restoreFollowUpsPage);
  let followUps: RestoreFollowUp[] | null;
  try {
    followUps = await getRestoreFollowUps();
  } catch {
    followUps = null;
  }
  const now = new Date().toISOString();
  const { steps, restores } = followUpTotals(followUps ?? []);

  return (
    <>
      <PageHeader
        description={DESCRIPTION}
        generatedAt={now}
        section="Restore"
        status={followUps === null ? undefined : steps ? { tone: "soon", label: `${steps} open` } : { tone: "fine", label: "All done" }}
        title={TITLE}
      />
      {followUps === null ? (
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
            <RestoreFollowUps followUps={followUps} now={now} />
          </div>
        </>
      )}
    </>
  );
}
