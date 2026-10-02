import Link from "next/link";

export default function NotFound() {
  return (
    <section className="empty-state state-page">
      <p className="eyebrow">404</p>
      <h2>Nothing here</h2>
      <p>The page or record you asked for does not exist, or is no longer available.</p>
      <div className="form-actions">
        <Link className="btn btn-primary" href="/">
          Go to dashboard
        </Link>
        <Link className="btn btn-ghost" href="/jobs">
          View jobs
        </Link>
      </div>
    </section>
  );
}
