"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** "Try again": reads the page again from the server, keeping the menu and scroll. */
export function RetryButton({ label = "Try again" }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button aria-busy={pending || undefined} className="btn" disabled={pending} onClick={() => start(() => router.refresh())} type="button">
      {label}
    </button>
  );
}
