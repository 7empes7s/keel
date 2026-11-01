"use client";

import { useState } from "react";

import { RecoveryCompletion } from "@/components/recovery-completion";

/** A restore's follow-up steps on its card, for a restore with no job page. The steps
 * are read only once the card is opened, so a page of such cards sends no requests. */
export function FollowUpSteps({ restoreRef, canComplete }: { restoreRef: string; canComplete: boolean }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="follow-up-steps" onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
      <summary>Show the steps</summary>
      {opened ? <RecoveryCompletion canComplete={canComplete} restoreRef={restoreRef} /> : null}
    </details>
  );
}
