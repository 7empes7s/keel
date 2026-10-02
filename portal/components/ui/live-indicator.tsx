// A visible promise that the page is polling. Without it, rows changing under the
// operator look like a glitch rather than progress.
export function LiveIndicator({ intervalMs }: { intervalMs: number }) {
  return (
    <p className="live-indicator" role="status">
      <span aria-hidden="true" className="live-dot" />
      Live · refreshing every {Math.round(intervalMs / 1000)}s
    </p>
  );
}
