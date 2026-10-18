import { headers } from "next/headers";
import { connection } from "next/server";
import Link from "next/link";

import { GET as loadSetup } from "@/app/api/setup/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/components/settings/parts";
import { SetupProgress } from "@/components/setup-progress";
import { Badge } from "@/components/ui/badge";
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
    <div className="pt-page" data-layer="explanation">
      {data.firstCollection ? (
        <SettingsSection about="The newest backup KEEL took with the access below." id="setup-first-backup" title="Latest backup">
          <SettingsGroup>
            <SettingsRow
              actions={<Link className="btn btn-sm" href="/protect">See every type</Link>}
              icon="backup"
              iconTone={data.firstCollection.notRead ? "soon" : null}
              line={<>{data.firstCollection.read} configuration types read{data.firstCollection.notRead ? `, ${data.firstCollection.notRead} could not be read` : ""}, including the ones KEEL cannot back up yet.</>}
              meta={`Finished ${formatTimestamp(data.firstCollection.completedAt)}`}
              name="First backup"
              status={<Badge tone={data.firstCollection.notRead ? "soon" : "fine"}>{data.firstCollection.notRead ? "Partly read" : "Finished"}</Badge>}
            />
          </SettingsGroup>
          <TechnicalDetails>
            <RecordField label="Snapshot ID" usage="the snapshot the Protect page reports" value={data.firstCollection.snapshotId} />
          </TechnicalDetails>
        </SettingsSection>
      ) : null}
      {data.scopes.map((setup) => (
        <SetupProgress
          canCheck={data.canCheck}
          checkFailed={data.checkFailed ?? false}
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
