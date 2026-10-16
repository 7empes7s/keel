import { connection } from "next/server";
import { headers } from "next/headers";

import { CreateWizard } from "@/components/baselines/create-wizard";
import { BaselinesStyles } from "@/components/baselines/styles";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { toDay } from "@/lib/date-range";
import { CAPABILITIES_HEADER } from "@/lib/principal";
import { getSnapshotOptions, hasCompletedSnapshots, type SnapshotOption } from "@/lib/portal-jobs";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Copy how the tenant looked in one complete backup, so every later change is measured against it.";

export default async function NewBaselinePage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.baselinesNewPage);
  const capabilities = ((await headers()).get(CAPABILITIES_HEADER) ?? "").split(" ").filter(Boolean);
  // The action API re-checks baseline-create on every request; this only greys the button.
  const canBaseline = capabilities.includes("baseline-create");

  let snapshots: SnapshotOption[];
  let completedSnapshotsExist: boolean;
  try {
    [snapshots, completedSnapshotsExist] = await Promise.all([getSnapshotOptions(), hasCompletedSnapshots()]);
  } catch {
    return (
      <>
        <PageHeader description={DESCRIPTION} section="Baselines" title="New approved setup" />
        <DataUnavailable surface="Baselines" />
      </>
    );
  }
  const now = new Date();
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={now.toISOString()} section="Baselines" title="New approved setup" />
      <Verdict
        text={snapshots.length ? "Three short steps: pick a backup, name it, then check what will happen." : "There is no complete backup to copy yet."}
        tone={snapshots.length ? "good" : "attention"}
      />
      <div data-layer="explanation">
        <BaselinesStyles />
        <CreateWizard completedSnapshotsExist={completedSnapshotsExist} disabled={!canBaseline} snapshots={snapshots} today={toDay(now)} />
      </div>
    </>
  );
}
