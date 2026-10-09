# Basic Entra tenant settings (issue #156)

## Status — 2026-10-09

Implemented and fixture-tested. **Nothing here is live-qualified.** Every
restore claim below is `fixture-tested`: the production `applyWave()` writer
and its read-back ran against an in-memory fake Graph. No tenant was read or
written. Live qualification needs an operator gate like the one in issue #148.

## What is backed up

Five settings were not catalogue types, so no snapshot ever held them. Each is
now a catalogue type with a descriptor, and is collected with every backup.
A setting the tenant never configured is a valid, empty backup, not a failure.

| Setting | Read | Key | Empty backup when |
| --- | --- | --- | --- |
| Company branding (default) | `GET /organization/{tenant}/branding`, sent with `Accept-Language: 0` | constant | Graph answers 404 (no branding set up) |
| Company branding languages | `GET /organization/{tenant}/branding/localizations` | the language (for example `fr-FR`) | the list is empty, or Graph answers 404 |
| Group expiration | `GET /groupLifecyclePolicies` | the policy id | the list is empty |
| Device registration and join | `GET /policies/deviceRegistrationPolicy` | constant | never; it always exists |
| Self-service sign-up (user flows) | `GET /policies/authenticationFlowsPolicy` | constant | never; it always exists |

Notes:

- The Graph reader sends `Accept-Language: en-US` on every request. Company
  branding is the one exception: Graph returns the branding of the language
  named in that header, and only `0` returns the default. Its catalogue entry
  overrides the header.
- Only a 404 on company branding counts as "not set up". A 403 or any other
  error is still a failed read with unknown contents.
- The reconciliation plan reads the target tenant's organization id once,
  only when a branding type is in the plan.
- Branding images and the custom stylesheet are binary files. The backup holds
  their paths only. The CDN host list is Microsoft's and is left out of drift;
  a changed image path is reported as drift that KEEL cannot fix.

## What is restored

Every write goes through an explicit record in
`engine/restore/tenantPolicyOperations.mjs` (the same path as the task-149
tenant policies): an allowlist of fields, a PATCH of only the fields that
differ, and a read-back that must match.

| Setting | Restore | Route | Writes | Permission |
| --- | --- | --- | --- | --- |
| Company branding (default) | update | `PATCH /organization/{tenant}/branding` | sign-in page text, links, colours, layout and text visibility | OrganizationalBranding.ReadWrite.All |
| Company branding languages | update | `PATCH /organization/{tenant}/branding/localizations/{language}` | the same fields, per language | OrganizationalBranding.ReadWrite.All |
| Group expiration | update, guarded | `PATCH /groupLifecyclePolicies/{id}` | lifetime in days, which groups are covered, notification emails | Directory.ReadWrite.All |
| Self-service sign-up | update | `PATCH /policies/authenticationFlowsPolicy` | `selfServiceSignUp` | Policy.ReadWrite.AuthenticationFlows |
| Device registration and join | **none (manual)** | — | — | — |

Proof: `engine/roadmap/entra-basic-settings.test.mjs`. None of the permissions
is verified as granted to the KEEL Restorer.

### Safety rules

- **Group expiration can delete groups.** A restore may only make expiry less
  aggressive: a longer lifetime, or fewer groups covered (`All` → `Selected` →
  `None`). A shorter lifetime, wider coverage, or an unknown value is skipped
  with a `manual:` reason and nothing is sent.
- **Device registration is never written.** These settings decide who may
  register and join devices, who becomes a local admin on joined devices, and
  whether joining needs MFA. A wrong write could block admins from joining
  devices or silently drop the MFA requirement, so the setting is backed up
  and compared only, and its decision is `manual`. Every verb is refused.
- Nothing here is lockout-sensitive in the task-149 sense, so no break-glass
  lockout gate is needed.

## What is not restored

- Branding images (banner logo, square logos, header logo, background image,
  favicon) and the custom stylesheet. They are binary uploads with their own
  routes; set them by hand from the backed-up paths.
- A tenant with no branding, or a missing branding language: create is not
  registered, so the restore fails closed and lists it. Set it up by hand.
- A removed or added branding language, and a missing or extra group
  expiration policy: create and delete are not registered.
- Which groups a `Selected` group expiration policy covers. That list changes
  through the `addGroup` and `removeGroup` actions, which KEEL does not call.
- The user flows themselves (`/identity/b2xUserFlows`) are not collected.
  Only the tenant-wide self-service sign-up switch is.
- The device registration policy (see above).

## Not confirmed against Microsoft documentation

learn.microsoft.com is not reachable from the build container, so these are
declarations to confirm before any live qualification:

- That `GET /organization/{id}/branding` needs `Accept-Language: 0` for the
  default branding and answers 404 when none is set up, and whether the
  localizations list answers 404 or an empty list in that case.
- Whether `PATCH /organization/{id}/branding` needs `Accept-Language: 0`. The
  writer sends no `Accept-Language` header on writes or read-backs; if Graph
  then answers with another language, the read-back fails closed.
- The exact v1.0 field list of branding (for example `contentCustomization`
  and `headerBackgroundColor`), and the permission names above.
- That a tenant has at most one group expiration policy, and how Graph treats
  groups older than a shortened lifetime.
- Whether Graph v1.0 documents an update for the device registration policy.
  The decision stays manual either way.
