"use client";

// Last-resort boundary for an unexpected render failure. Expected read failures already
// render DataUnavailable in place; this only catches what slipped past them, and never
// shows a stack or message that could leak tenant detail.
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="data-error state-page" role="alert">
      <p className="severity-label">Unexpected error</p>
      <h2>This page could not be rendered</h2>
      <p>
        Nothing was changed. Retry the render, or return to the dashboard. If it keeps
        failing, check the portal service logs.
      </p>
      <div className="form-actions">
        <button className="btn btn-primary" onClick={() => reset()} type="button">
          Try again
        </button>
        <a className="btn btn-ghost" href="/">
          Go to dashboard
        </a>
      </div>
    </section>
  );
}
