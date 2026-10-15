# What you need before KEEL can back up and restore

This page tells you three things before you rely on a restore:

1. **Licences.** Some settings exist only when your tenant has a certain Microsoft licence. Without it there is nothing to back up, and nothing to restore.
2. **Permissions.** What KEEL's apps must be allowed to do in your tenant, and the few steps only an admin can take.
3. **Limits.** What no tool can bring back because Microsoft does not allow it, and what comes back only with steps you take yourself.

For the full list of every setting, what KEEL restores and the exact steps for each, see [What KEEL covers](coverage.md). That page is built from the code and is always current. This page summarises it and adds the licences and permissions.

## Quick check

Before you count on a restore, check each of these:

- [ ] Your tenant holds the licences for the settings you care about (see [Licences](#licences)).
- [ ] An admin has consented to KEEL's apps and given them their admin roles (see [Permissions](#permissions)).
- [ ] For Power Platform and Power BI, an admin has done the two extra steps in [Admin portal steps](#admin-portal-steps).
- [ ] You know which settings come back only with your own steps (see [What comes back only with your steps](#what-comes-back-only-with-your-steps)).
- [ ] You keep the things Microsoft never gives back somewhere safe: passwords, app secrets and certificates, Wi-Fi and VPN keys, and device hardware hashes (see [What no tool can restore](#what-no-tool-can-restore)).

## Licences

A setting that needs a licence your tenant does not have does not exist in your tenant. KEEL notices that Microsoft refused for licence reasons, says "not licensed", and backs up everything else. A restore leaves those settings out.

If you buy the licence later, KEEL starts backing those settings up on the next run. It cannot back up what existed before.

### Entra ID (users, groups, apps and sign-in)

| Setting | Licence needed | Without it |
| --- | --- | --- |
| Conditional Access policies, named locations, authentication strengths, authentication contexts | Microsoft Entra ID P1 (in Microsoft 365 Business Premium, E3 and E5) | Not available in the tenant |
| Custom admin roles | Microsoft Entra ID P1 or P2 | Microsoft refuses to create a custom role, so KEEL cannot restore one |
| Eligible admin roles, time-limited admin roles, admin role activation settings (Privileged Identity Management) | Microsoft Entra ID P2 (in E5) | Not available in the tenant |
| Access reviews | Microsoft Entra ID P2 or Microsoft Entra ID Governance | Not available in the tenant |
| Access packages, catalogs, policies, assignments, connected organizations, entitlement management settings | Microsoft Entra ID P2 or Microsoft Entra ID Governance | Not available in the tenant |
| Lifecycle workflows, their extensions and settings | Microsoft Entra ID Governance | Microsoft answers "insufficient licence"; KEEL skips them |
| Terms of use | Microsoft Entra ID P1 | Not available in the tenant |
| Guest sign-up user flows and their API connectors | No licence, but self-service sign-up must be turned on for the tenant | Microsoft answers "self-service sign-up is not enabled"; KEEL skips them |
| Users | Any. A restored user gets back only licences the tenant still holds | Buy or reactivate licences before you restore users |

### Intune (devices)

| Setting | Licence needed |
| --- | --- |
| Every Intune setting | Microsoft Intune Plan 1 (in Microsoft 365 Business Premium, E3 and E5, and EMS) |
| Remediation scripts, Windows feature, quality and driver update profiles | Also Windows Enterprise E3 or E5 (or Education A3 or A5) for the devices, per Microsoft |

### Microsoft 365 workloads

The SharePoint, OneDrive, Exchange and Teams settings need those services in the tenant, which every Microsoft 365 business plan includes. These need more:

| Setting | Licence needed | Without it |
| --- | --- | --- |
| Safe Links and Safe Attachments policies and rules, Defender preset security policies, Defender for Office 365 apps settings | Microsoft Defender for Office 365 (Plan 1 or 2, in E5 and Business Premium) | KEEL skips them and backs up the rest of Exchange |
| Data loss prevention (DLP) policies and rules | A licence that includes Microsoft Purview Data Loss Prevention | KEEL skips them and backs up retention |
| Auto-labeling policies and rules | Microsoft Purview auto-labeling (E5, or E5 Compliance) | KEEL skips them |
| eDiscovery (Premium) cases | Microsoft Purview eDiscovery (Premium) (E5, or E5 Compliance) | KEEL skips them; Standard cases are still backed up |
| Power Platform and Power BI settings | No extra licence, but an admin must do two steps first (see [Admin portal steps](#admin-portal-steps)) | Microsoft refuses the read |

## Permissions

KEEL uses separate apps in your tenant, so the app that reads can never write:

| App | What it does | What it may do |
| --- | --- | --- |
| **KEEL Collector** | Backs up settings | Read only |
| **KEEL Restorer** | Restores settings | Read and write settings |
| **KEEL Content Reader** | Backs up mail, files, Teams and Planner | Read only |
| **Content restore** (the KEEL Restorer with content permissions added) | Restores mail and files | Write mail, calendars, contacts, files and sites |

An admin consents to each app once. Consent alone is not enough for some workloads: those also need an admin role given to the app, or a setting changed in an admin portal.

### Admin roles the apps need

| Workload | Role given to the app |
| --- | --- |
| Intune | Intune role "Read Only Operator" for the Collector |
| SharePoint and OneDrive settings | SharePoint Administrator |
| Exchange settings, mail flow and protection | Exchange Administrator |
| Purview labels, retention, DLP, auto-labeling, eDiscovery | Compliance Administrator |
| Teams organization, calling and voice policies | Teams Administrator |
| Power Platform settings | Power Platform Administrator, through the step below |
| Power BI settings | Fabric Administrator access, through the step below |

The person who consents to the Restorer must be a Privileged Role Administrator or Global Administrator, because the Restorer may change admin roles.

### Admin portal steps

These need a signed-in admin. No consent screen does them.

- **Power Platform:** register the KEEL Collector as a Power Platform management app (in PowerShell: `New-PowerAppManagementApp` with the Collector's application ID).
- **Power BI and Fabric:** in the Fabric admin portal, go to Tenant settings, then Admin API settings, and turn on "Service principals can access read-only admin APIs" for a security group that holds the KEEL Collector.
- **Content restore of calendars and contacts:** if you limit the restore app to some mailboxes with Exchange application access, give that scope calendar and contact write access too, not only mail. Otherwise Microsoft refuses calendar and contact restores.

### What KEEL never asks for

KEEL's setup never asks for whole-directory write access (`Directory.ReadWrite.All`) or full mailbox access (`full_access_as_app`), and its settings apps never get mail or file permissions. Only the content apps read or write mail and files.

The full list of permissions per app is under [Technical details](#technical-details).

## What no tool can restore

Microsoft does not let any tool read or write these. KEEL backs up what it can see and tells you what to do instead.

**Secrets and credentials.** Microsoft never lets anyone read them back, so no backup can hold them.

- User passwords and registered sign-in methods such as MFA. A recreated user starts with sign-in off and must get a new password or Temporary Access Pass and register MFA again.
- App registration and enterprise app client secrets and certificates. Create new ones after a restore and update every service that used them.
- External identity provider client secrets. Enter a fresh secret from the provider.
- Passwords, keys and certificates inside Intune Wi-Fi, VPN, certificate and email profiles, and other secret Intune settings.
- Sign-in details a provisioning job uses for its target app.
- A Teams live event video provider's API token.

**Things that only exist outside your tenant's settings.**

- Licences. They are bought, not configured. The backup shows what you had.
- Domains. Adding one needs proof of ownership through a DNS record only you can publish.
- The tenant itself (the organization profile).
- Organizational contacts that come from directory sync, and user details synced from on-premises Active Directory. Restore them at the source and let sync bring them back.
- Windows Autopilot device registrations. Microsoft never returns the hardware hash, so re-import it from the device or your vendor.
- Enrolled devices. A device record is created when the device enrolls.
- Device categories assigned to devices, and who accepted terms and conditions or terms of use. People accept again.

**History.** Past access reviews and their decisions, access package request and approval history, lifecycle workflow runs, provisioning run history, and admin role activations people made themselves.

**Set by Microsoft.** Built-in admin roles, role templates, group setting templates, built-in consent policies and built-in Intune items. There is nothing to restore.

**Power Platform and Power BI.** Their environments, DLP policies, connectors and Power BI tenant settings are backed up, but KEEL has no safe way to write them back, so it does not restore them. The Power Platform tenant settings page is not backed up at all, because Microsoft offers it only through a request that KEEL's read-only backup does not send. Change them by hand in the Power Platform admin center or the Fabric admin portal using the backup.

**Recently deleted items.** Microsoft keeps a deleted user, group or app for 30 days. After that it is gone from the recycle bin, and KEEL recreates it instead, which gives it a new ID.

## What comes back only with your steps

KEEL restores these partly, or leaves them to a person for safety. After a restore, KEEL lists each step you need to take with the values from the backup. The detail for every setting is in [What KEEL covers](coverage.md).

**Sign-in and access, left to you for safety.**

- A restored Conditional Access policy comes back in report-only mode. You turn it on, because a wrong policy can lock everyone out.
- Certificate sign-in settings, authentication contexts, default app credential rules, and changes that make group expiry shorter or weaken a protection setting.
- Authentication methods and other sign-in settings are put back only when KEEL can confirm your emergency (break-glass) accounts can still sign in afterwards.
- A restored lifecycle workflow stays off until you review it and turn it on.

**Restored by hand from the backup.** These are backed up in full, and KEEL does not restore them yet: access reviews, access packages and their policies and assignments, connected organizations, terms of use, guest sign-up user flows and API connectors, provisioning jobs, time-limited admin roles, and several Intune settings (scripts, enrollment settings, Autopilot profiles, apps, administrative templates and Intune admin roles).

**Workloads.** KEEL restores a set of SharePoint, Teams, Exchange and Purview settings. Everything else in those workloads, and anything deleted, is changed by hand in its admin center using the backup. Who a Teams policy is assigned to is not restored, and a deleted named policy comes back assigned to nobody.

**Mail and files.**

- Mail: restored messages, calendars, contacts and To Do lists come back as copies, never overwriting newer items. Meetings come back without attendees, so no invitations go out; the attendees are listed in the event. Signed or encrypted messages, drafts and very large messages come back as drafts. Group and archive mailboxes are not restored.
- Files: restored files sit next to newer versions as copies unless you ask to replace them. Sharing is restored only when you ask, and only for direct grants to people and groups that still exist. Sharing links, owners and inherited sharing are reported, not recreated. Lookup, person and calculated list columns are not restored.
- Teams messages: not backed up yet. Microsoft requires its own approval before any app may export channel messages, and KEEL is waiting on it.
- SharePoint site-level app permissions are not part of the content backup: reading them needs full control of every site, which the read-only Content Reader does not get. The settings backup still records them.

## Known gaps right now

The daily backup on our test tenant shows the licence and feature limits above in practice: lifecycle workflows fail without Entra ID Governance, and guest sign-up API connectors fail because self-service sign-up is off. These are tracked in [the daily collection issue](https://github.com/7empes7s/keel/issues/309), which also covers making such types show as "not licensed" rather than failed.

## Technical details

### Microsoft Graph permissions the Collector holds

Read only: `User.Read.All`, `Group.Read.All`, `GroupMember.Read.All`, `Application.Read.All`, `RoleManagement.Read.All`, `RoleManagement.Read.Directory`, `Policy.Read.All`, `DeviceManagementConfiguration.Read.All`, `DeviceManagementManagedDevices.Read.All`, `DeviceManagementScripts.Read.All`, `LifecycleWorkflows.Read.All`, `CustomSecAttributeDefinition.Read.All`, `Agreement.Read.All`, `MultiTenantOrganization.Read.All`, `IdentityUserFlow.Read.All`, `APIConnectors.Read.All`, `SharePointTenantSettings.Read.All`, `Sites.Read.All`, `TeamSettings.Read.All`, `TeamMember.Read.All`, `Team.ReadBasic.All`, `MailboxSettings.Read`, and `Exchange.ManageAsApp` for Exchange and Purview, plus the other read permissions in its app manifest.

### Microsoft Graph permissions the Restorer needs, by area

| Area | Permission |
| --- | --- |
| Users | `User.ReadWrite.All` |
| Groups | `Group.ReadWrite.All` |
| App registrations, enterprise apps | `Application.ReadWrite.All` |
| Delegated app consents | `DelegatedPermissionGrant.ReadWrite.All` |
| Admin roles and assignments | `RoleManagement.ReadWrite.Directory` |
| Eligible admin roles | `RoleEligibilitySchedule.ReadWrite.Directory` |
| Admin role activation settings | `RoleManagementPolicy.ReadWrite.Directory` |
| Conditional Access, named locations, authentication strengths | `Policy.ReadWrite.ConditionalAccess` |
| Authentication methods | `Policy.ReadWrite.AuthenticationMethod` |
| Security defaults | `Policy.ReadWrite.SecurityDefaults` |
| Guest and consent settings | `Policy.ReadWrite.Authorization` |
| Cross-tenant access | `Policy.ReadWrite.CrossTenantAccess` |
| App consent policies | `Policy.ReadWrite.PermissionGrant` |
| Admin consent requests | `Policy.ReadWrite.ConsentRequest` |
| Authentication flows | `Policy.ReadWrite.AuthenticationFlows` |
| Token, claims, home realm and app management policies | `Policy.ReadWrite.ApplicationConfiguration` |
| Access package catalogs, entitlement settings | `EntitlementManagement.ReadWrite.All` |
| Lifecycle workflows | `LifecycleWorkflows.ReadWrite.All` |
| Custom security attributes | `CustomSecAttributeDefinition.ReadWrite.All` |
| Multitenant organization | `MultiTenantOrganization.ReadWrite.All` |
| Group settings | `GroupSettings.ReadWrite.All` |
| Administrative units | `AdministrativeUnit.ReadWrite.All` |
| Company branding | `OrganizationalBranding.ReadWrite.All` |
| Group expiry | `Directory.ReadWrite.All`. KEEL's setup never requests this broad permission, so an admin grants it only if they want group expiry restored |
| Intune configuration and compliance | `DeviceManagementConfiguration.ReadWrite.All` |
| Intune notification templates | `DeviceManagementServiceConfig.ReadWrite.All` |
| Intune scope tags | `DeviceManagementRBAC.ReadWrite.All` |
| Intune app protection and app configuration | `DeviceManagementApps.ReadWrite.All` |
| SharePoint settings | `SharePointTenantSettings.ReadWrite.All` with SharePoint Administrator |
| Teams settings and membership | `TeamSettings.ReadWrite.All`, `TeamMember.ReadWrite.All` |
| Mailbox settings | `MailboxSettings.ReadWrite` |
| Exchange and Purview | `Exchange.ManageAsApp` with Exchange Administrator or Compliance Administrator |

### Content Reader permissions

`Mail.Read`, `Calendars.Read`, `Contacts.Read`, `MailboxSettings.Read`, `User.Read.All`, `MailboxFolder.Read.All`, `MailboxItem.Read.All`, `Files.Read.All`, `Sites.Read.All`, `Group.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelSettings.Read.All`, `ChannelMember.Read.All`, `TeamsTab.Read.All`, `TeamsAppInstallation.ReadForTeam.All`, `Tasks.Read.All`. Teams channel messages need `ChannelMessage.Read.All`, which Microsoft grants only after approving the app for its protected export API.

### Content restore permissions

`Mail.ReadWrite`, `Calendars.ReadWrite`, `Contacts.ReadWrite`, `Files.ReadWrite.All`, `Sites.ReadWrite.All`. These are broad, so limit them to the mailboxes and sites you restore into with Exchange application access policies and SharePoint site permissions where you can.

### Where this comes from in the code

- Licences per workload: the `license` fields in `engine/collect/workloads/` (mail flow, Exchange, Purview).
- Licence and feature refusals in Entra: `unavailableOnTenant` in `engine/collect/entraAdapter.mjs`; licence checks in `engine/coverage/diagnosis.mjs`.
- Permissions per app: `engine/bootstrap/prerequisites.mjs`, `engine/collect/workloadContract.mjs`, and the `permission` of each type in `engine/coverage/qualification.mjs`.
- Limits and your steps per setting: [What KEEL covers](coverage.md), generated from `engine/coverage/qualification.mjs`.
