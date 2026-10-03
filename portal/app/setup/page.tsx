import { headers } from "next/headers";
import { connection } from "next/server";
import Link from "next/link";

import { GET as loadSetup } from "@/app/api/setup/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { SetupProgress } from "@/components/setup-progress";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Verdict } from "@/components/verdict";
import { formatTimestamp } from "@/lib/presentation";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { setupVerdict, type SetupState } from "@/lib/setup-view";

const DESCRIPTION = "Connect KEEL to your Microsoft tenant: what is in place, what is waiting on you, and when the first backup can run.";

// Roadmap task-76: guided onboarding. Read access and write access are set up
// separately, so a missing restore prerequisite never holds up the first backup.
export default async function SetupPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.setupPage);
  let data: SetupState;
  try {
    const response = await loadSetup(new Request("http://localhost/api/setup", { headers: await headers() }));
    if (!response.ok) throw new Error("Setup unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Settings" title="Setup" description={DESCRIPTION} /><DataUnavailable surface="Setup" /></>;
  }
  const verdict = setupVerdict(data);
  const canStart = access.capabilities.includes("approve");
  return <>
    <PageHeader section="Settings" title="Setup" description={DESCRIPTION} generatedAt={data.generatedAt} />
    <Verdict
      action={data.collect.allowed && !data.firstCollection ? { label: "Run the first backup", href: "/protect" } : null}
      text={verdict.text}
      tone={verdict.tone}
    />
    {data.firstCollection ? (
      <section className="item-card setup-first-backup" aria-labelledby="setup-first-backup">
        <div className="item-card-head"><h2 id="setup-first-backup">Latest backup</h2></div>
        <p>
          Finished {formatTimestamp(data.firstCollection.completedAt)}: {data.firstCollection.read} configuration types read
          {data.firstCollection.notRead ? `, ${data.firstCollection.notRead} could not be read` : ""}.{" "}
          <Link className="text-link" href="/protect">See every configuration type, including the ones KEEL cannot back up yet</Link>.
        </p>
        <TechnicalDetails>
          <RecordField label="Snapshot ID" usage="the snapshot the Protect page reports" value={data.firstCollection.snapshotId} />
        </TechnicalDetails>
      </section>
    ) : null}
    <div className="item-list" data-layer="explanation">
      {data.scopes.map((setup) => (
        <SetupProgress
          canCheck={data.canCheck}
          canProvision={data.canProvision}
          canStart={canStart}
          key={setup.scope}
          now={data.generatedAt}
          setup={setup}
        />
      ))}
    </div>
  </>;
}
