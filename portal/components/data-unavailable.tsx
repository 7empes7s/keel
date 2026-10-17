import { Icon } from "@/components/shell/icons";
import { RetryButton } from "@/components/ui/retry-button";

// Portal experience contract, copy voice: name the thing in the reader's words and the
// next step; never the engine name. No stale value is ever substituted.
// Without `service` the failure is Keel's own records; with it, an outside service
// (ServiceNow, Microsoft 365) that Keel could not reach, and a link to its connection.
export function DataUnavailable({ surface, service }: { surface: string; service?: { name: string; href?: string; linkLabel?: string } }) {
  return (
    <section className="data-error" data-cause={service ? "service" : "database"} role="alert">
      <Icon className="data-error-icon" name="alert" />
      <div className="data-error-body">
        <h2>{surface} could not be read</h2>
        <p>
          {service
            ? `Keel could not reach ${service.name} just now. Your other pages still work. If this keeps failing, check the ${service.name} connection.`
            : "Keel could not read its own records just now. Try again in a minute; if it keeps failing, ask whoever runs Keel to check that it is up."}
        </p>
        <div className="form-actions">
          <RetryButton />
          {service?.href ? <a className="btn" href={service.href}>{service.linkLabel ?? "Open the connection"}</a> : null}
        </div>
      </div>
    </section>
  );
}
