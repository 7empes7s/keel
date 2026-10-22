import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import { Badge, BADGE_ICONS } from "@/components/ui/badge";
import {
  credentialsFine, credentialWarnings, lastReadWords, servicesSummary,
  type ConnectionExpiry, type ServiceFix, type ServiceStatus,
} from "@/lib/setup-services";

// Setup: the Keel app sign-in warnings first, then one tile per Microsoft 365 service
// saying whether its backup works, what Keel can put back, the last good read and the
// one thing to fix, with a link to fix it. Worst first; colour is never the only signal.

export function CredentialAlerts({ credentials, canCheck, now }: {
  credentials: ConnectionExpiry[] | null | undefined;
  canCheck: boolean;
  now: string;
}) {
  const warnings = credentialWarnings(credentials, now);
  if (warnings.length) {
    return (
      <section aria-label="Keel app sign-in" className="su-expiry">
        {warnings.map((warning) => (
          <div className="su-expiry-row" data-tone={warning.tone} key={warning.role} role={warning.tone === "urgent" ? "alert" : "status"}>
            <Icon name={warning.tone === "urgent" ? "x-circle" : "clock"} />
            <div>
              <b>{warning.title}</b>
              <p>{warning.detail}</p>
            </div>
            <FixLink fix={warning.fix} />
          </div>
        ))}
      </section>
    );
  }
  const fine = credentialsFine(credentials);
  if (fine) return <p className="su-expiry-fine"><Icon name="check-circle" />{fine}</p>;
  return canCheck && credentials === null
    ? <p className="su-expiry-fine" data-tone="neutral"><Icon name="info" />Keel could not read when its app certificates end. Press Check again to try again.</p>
    : null;
}

export function ServiceStatusSection({ services, now }: { services: ServiceStatus[] | null; now: string }) {
  if (services === null) {
    return (
      <section aria-labelledby="su-svc-title" className="su-svc">
        <h2 id="su-svc-title">Services</h2>
        <p className="action-error">Keel could not read what each service has backed up just now. Reload in a minute.</p>
      </section>
    );
  }
  const summary = servicesSummary(services);
  return (
    <section aria-labelledby="su-svc-title" className="su-svc">
      <header className="su-svc-head">
        <h2 id="su-svc-title">Services</h2>
        <p data-tone={summary.tone}><Icon name={BADGE_ICONS[summary.tone]} />{summary.text}</p>
      </header>
      <ul className="su-svc-grid">
        {services.map((service) => (
          <li className="su-svc-tile" data-tone={service.tone} key={service.code}>
            <div className="su-svc-name">
              <Icon name={service.icon} />
              <b>{service.name}</b>
              <Badge tone={service.tone}>{service.label}</Badge>
            </div>
            <dl className="su-svc-lines">
              <div data-tone={service.backup.tone}><dt>Backup</dt><dd>{service.backup.text}</dd></div>
              <div data-tone={service.restore.tone}><dt>Restore</dt><dd>{service.restore.text}</dd></div>
            </dl>
            <small className="su-svc-read">
              {service.lastGoodRead
                ? <time dateTime={service.lastGoodRead}>{lastReadWords(service, now)}</time>
                : lastReadWords(service, now)}
            </small>
            {service.blocker ? (
              <div className="su-svc-blocker">
                <p><Icon name="alert" />{service.blocker.text}</p>
                {service.blocker.fix ? <FixLink fix={service.blocker.fix} /> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FixLink({ fix }: { fix: ServiceFix }) {
  if (fix.href.startsWith("https://")) {
    return (
      <a className="btn su-fix" href={fix.href} rel="noreferrer" target="_blank">
        <Icon name="link" />{fix.label}<span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    );
  }
  if (fix.href.startsWith("#")) return <a className="btn su-fix" href={fix.href}>{fix.label}</a>;
  return <Link className="btn su-fix" href={fix.href}>{fix.label}</Link>;
}
