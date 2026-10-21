"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Icon } from "@/components/shell/icons";

// "Check again": the server reads the tenant afresh on every page read, so a refresh
// re-checks every step without reloading the page.
export function CheckAgain() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button aria-busy={pending || undefined} className="btn" disabled={pending} onClick={() => start(() => router.refresh())} type="button">
      <Icon name="refresh" />{pending ? "Checking…" : "Check again"}
    </button>
  );
}
