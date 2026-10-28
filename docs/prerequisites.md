# What KEEL can recover, and what you need first

This page sorts everything KEEL backs up into five groups. Use it to tell what can come back, what needs work by hand, and whether a
tenant has everything KEEL needs. [What KEEL covers](coverage.md) has the full per-type detail and follow-up steps.

1. **Fully recoverable** (for example from the recycle bin).
2. **Partially recoverable** (recreated by script).
3. **Missing important config** (secrets, certificates and so on).
4. **Missing prerequisites** (licences, resources, storage endpoints).
5. **Not supported.**

The rule: if PowerShell, Graph or another Microsoft API or command line can recreate something from the backup, it is at least
partially recoverable, even when steps are left for a person. "Not supported" is only for what nothing can recreate.

Where a fact comes from:

- **Live:** checked on KEEL's test tenant on 2026-10-15.
- **Microsoft docs:** from Microsoft's documentation, not tested on a tenant without the licence.
- Everything else comes from KEEL's code and `coverage.md`.

## 1. Fully recoverable

KEEL puts these back on its own, and nothing is missing.

- **Deleted directory objects, from the recycle bin.** For 30 days after a delete, users, groups, app registrations and
  Conditional Access policies come back with the same id from Entra's deleted items.
- **Entra ID:**
  - groups and their members and owners;
  - delegated app consents;
  - custom admin roles and admin role assignments;
  - Conditional Access policies, named locations, authentication methods, security defaults and user and guest permissions;
  - cross-tenant access, its defaults and each organization's entry;
  - external user self sign-up, admin consent requests, entitlement management settings and lifecycle workflow settings.
- **Intune:** compliance policies, app configuration for managed devices, assignment filters and compliance notification emails.
- **Files.** OneDrive and SharePoint files and list items come back at a chosen time or version. A restore never overwrites a newer
  file: by default it writes "<name> (restored <date>)" next to it. Large files are restored byte-identical (live, 5 MiB). Sharing is
  in group 2.

## 2. Partially recoverable

KEEL recreates these from the backup, or a person does by script or in the admin center. The parts that cannot come back are in
group 3.

**KEEL recreates them, then lists follow-up steps:**

- **Entra ID:**
  - users (sign-in left off until a new password and MFA are set);
  - app registrations and enterprise apps;
  - eligible admin roles and role activation settings;
  - lifecycle workflows and their extensions;
  - custom security attributes and attribute sets;
  - access package catalogs;
  - authentication strengths, app consent policies and app credential policies;
  - token lifetime, token issuance, claims mapping and home realm discovery policies;
  - tenant-wide group settings, company branding, group expiration and administrative units;
  - multitenant organization.
- **Intune:** device configuration profiles, app protection policies, managed app configuration, scope tags, and Windows feature,
  quality and driver update profiles.
- **Microsoft 365:** the restorable settings of SharePoint, Teams, Exchange mailboxes, Exchange mail flow and protection, Purview
  labels and retention. `coverage.md` lists which settings, per workload.
- **Mail, calendars, contacts and To Do** (live):
  - Restored into "Restored <date>" folders, or back into the original folders. Nothing in the mailbox is overwritten.
  - Restored messages come back as received mail with their original dates (#301).
  - Exceptions (group 3): signed, encrypted, very large and draft messages come back as drafts; events come back without attendees,
    so no invitations go out.
  - Group and archive mailboxes are not restored yet.

**A person restores them from the backup** (KEEL keeps the full backup; restore through Graph, PowerShell or the admin center):

- **Entra ID:**
  - access packages, their policies, assignments and resource roles;
  - access reviews and connected organizations;
  - terms of use and guest sign-up user flows;
  - API connectors and provisioning and cross-tenant sync jobs;
  - authentication contexts, idle sign-out and staged rollout;
  - default app credential rules and certificate sign-in settings;
  - time-limited active admin roles;
  - domains (DNS proof needed, group 3).
- **Intune:**
  - Windows Autopilot profiles and security baselines (older format);
  - apps, Intune admin roles and their assignments;
  - PowerShell scripts, macOS shell scripts, remediations and custom compliance scripts;
  - administrative templates and imported template files;
  - enrollment restrictions, device categories and terms and conditions.
- **Exchange, Teams and Purview:**
  - settings KEEL doesn't write yet, such as domains, anti-spam, anti-phish, malware, DKIM, Safe Links and Safe Attachments;
  - deleted rules and connectors;
  - Teams policy assignments;
  - deleted retention and sensitivity labels, auto-labeling and eDiscovery case settings.
- **OneDrive settings, and Power Platform and Power BI settings.** KEEL restores nothing here yet.
  - The Power Platform **tenant settings** are not even backed up yet: Microsoft only returns them to a POST, and KEEL's
    collector reads with GET only. That is a backup gap to close, not a Microsoft limit.
- **Organizational contacts synced from on-premises:** restore them in Active Directory.

### SharePoint site permissions

| What | Backed up | Restored | What it needs |
|---|---|---|---|
| Site-level **app** permission grants | Yes, by the settings backup (the Collector, Graph `/sites/{id}/permissions`), with each site's sharing settings and properties | By hand or script: Graph `POST /sites/{id}/permissions` | `Sites.FullControl.All`. Graph offers nothing narrower for these grants. |
| **SharePoint groups and per-user permissions** on sites | Yes, by the content backup (the Collector, SharePoint REST): permission levels, groups and their members, site collection admins, and role assignments on each site and on lists with their own permissions. Unique permissions on single items and folders are not read. | KEEL adds back what is missing: custom permission levels, groups, members, site collection admins and role assignments. It never removes or narrows anything; whatever is wider than the backup, a changed group or level, and inheritance changes are listed for a person. Switched off until proven live. | SharePoint Online `Sites.FullControl.All`: the Collector to read, the Restorer to write. |
| **File and folder sharing** (in a file restore) | Yes, with the file | Only when asked, and only **direct grants** to users and groups that still exist. Sharing links, owners and inherited permissions are reported, not recreated. No invitation mail is sent. | The Restorer's file write permissions |

The tenant-wide **sharing settings** are restored by KEEL (group 1).

## 3. Missing important config

These parts of an object cannot come back from any backup. A recreate in group 2 leaves them for a person, and KEEL lists each one
as a follow-up step.

- **Passwords and sign-in methods.** Microsoft never returns a user's password or registered MFA methods. A recreated user needs a new
  password or Temporary Access Pass and registers MFA again.
- **App secrets and certificates.** Client secrets and certificates of app registrations, the client secret of an external identity
  provider, and the sign-in details of a provisioning target app are never returned. Create new ones and update every service that
  used them.
- **Secrets inside Intune profiles.** Passwords, keys and certificates in Wi-Fi, VPN, certificate and email profiles.
- **Windows Autopilot hardware hash.** Microsoft never returns it, so a device cannot be registered again from a backup. Import the
  hash from the device or the supplier.
- **Documents and tokens.** The terms of use agreement PDF, and a Teams live event video provider's API token.
- **DNS proof for domains.** Adding a domain back needs a DNS record only the domain owner can publish.
- **Not in the backup yet:** which apps a token, claims or home realm discovery policy is assigned to, and the attribute mappings
  of a provisioning job.
- **Left to a person on purpose:**
  - making a policy the organization default again, because it changes sign-in for every app at once;
  - switching a restored lifecycle workflow on.
- **Mail fidelity:**
  - Signed, encrypted, draft and very large messages come back as drafts.
  - Events come back without attendees; the original attendee list is in the event body.

## 4. Missing prerequisites

### Licences and tenant features

Without these, Microsoft refuses the read, so there is nothing to back up or restore for that type.

Today the daily settings backup still reports those types as failed and ends with an error (#309). Restores and drift checks
already skip them.

| What | Needs | Source |
|---|---|---|
| Lifecycle workflows, their extensions and lifecycle settings | **Microsoft Entra ID Governance** | Live (403 "Insufficient license") |
| API connectors for user flows | **Self-service sign-up** turned on for External ID | Live (400 `AADB2C99039`) |
| Conditional Access, named locations, authentication strengths, terms of use | **Microsoft Entra ID P1** or P2 | Microsoft docs |
| Custom admin roles | **Microsoft Entra ID P1** or P2 | coverage.md |
| Eligible and time-limited admin roles (PIM), access reviews, access packages | **Microsoft Entra ID P2** or **Entra ID Governance** | Microsoft docs |
| Safe Links and Safe Attachments policies and rules, Defender preset rules, Defender for Office 365 app settings | **Microsoft Defender for Office 365** | coverage.md |
| Purview data loss prevention, auto-labeling, eDiscovery (Premium) | A **Purview** licence that includes them | coverage.md |
| Intune settings | An **Intune** licence | Microsoft docs |
| Mailboxes, OneDrive, sites and teams | The Microsoft 365 licence for each user and site | Microsoft docs |

A user restore can only assign licences the tenant still holds, so buy or reactivate licences before restoring users.

### Apps, roles and consent

KEEL uses three app registrations. A Global Administrator grants admin consent for each.

- **Collector** (backs up settings):
  - Microsoft Graph read permissions, and Exchange `Exchange.ManageAsApp`.
  - The directory roles Global Reader, Security Reader, **Exchange Administrator, SharePoint Administrator and Compliance
    Administrator**, and the Intune role Read Only Operator.
  - An Exchange role group for address lists.
  - It is mostly read-only, but not strictly. It holds `Sites.FullControl.All` and those three admin roles because Microsoft
    offers no read-only way to read site permission grants, SharePoint, Exchange and Purview admin settings. KEEL only reads with it.
- **Content reader** (backs up content): 17 Microsoft Graph read permissions and nothing that can write (live).
- **Restorer** (writes during an approved restore):
  - Microsoft Graph write permissions, plus the admin roles for what it restores.
  - `Tasks.ReadWrite.All` restores To Do lists (live).
  - Mail, calendars and contacts use **Exchange RBAC for Applications** roles (`Application Mail.ReadWrite`, `Application
    Calendars.ReadWrite`, `Application Contacts.ReadWrite`), scoped to chosen mailboxes. Mailboxes outside the scope stay closed
    (live, 403).
  - These roles took about 90 minutes to take effect (live; Microsoft says 30 minutes to 2 hours).
  - KEEL's setup never asks for tenant-wide `Mail.ReadWrite` or `Files.ReadWrite.All`, so an administrator grants the content
    restore permissions by hand.
  - Teams channel messages are restored through Microsoft's message import API, which needs `Teamwork.Migrate.All`
    (application), plus `Channel.ReadBasic.All`, `Team.ReadBasic.All` and `User.Read.All` to find the team and channel and
    check each author. The import API needs no approval from Microsoft; only reading messages does (below).
- **Power BI and Fabric** (live):
  - The Collector reads them through Microsoft's read-only admin APIs, which need a security group with the Collector as its only
    member.
  - The Fabric tenant setting "Service principals can access read-only admin APIs" must be on for that group (up to 15 minutes to
    take effect).
  - The Collector must hold no Power BI permission.
- **Power Platform:** an administrator registers the Collector once as a management application (`New-PowerAppManagementApp`).
  Until then, Power Platform reads return 403 (live).

### Microsoft approval

- **Teams channel messages.** Microsoft's export API for them (`ChannelMessage.Read.All`) is a protected API: Microsoft has to
  approve each app before it can read messages. Once approved, the permission is added to the content reader and consented like the
  others. Until then, KEEL backs up teams, channels, tabs and apps, but not the messages.
  - The restore side is ready: once messages are backed up, KEEL restores a channel's messages into a new channel with their
    original authors and times (`keel-content-restore.mjs teams`). On the test tenant it is proved with a fixture file instead.
  - The request to Microsoft is the "Protected APIs in Microsoft Teams" form, filed by the tenant's administrator for the
    content reader app.

### Storage

- **Content store:** a directory on the KEEL host, plus a 32-byte content key file. The content is encrypted with that key, so
  **losing the key loses the backed-up content.** Keep a copy of the key outside the host.
- **Offsite copy of KEEL's database:** a storage target that is a separate disk from the local backups. It is checked by its
  sha256 after every copy.

## 5. Not supported

Nothing can recreate these, with KEEL or any other tool:

- **The tenant itself and its licence subscriptions.** A tenant is created by Microsoft, and licences are bought.
- **Enrolled devices.** A device record is created by the device when it enrolls; the device enrolls again.
- **History and acceptances:**
  - past access review decisions;
  - access package request and approval history;
  - lifecycle workflow and provisioning run history;
  - who accepted terms of use or terms and conditions (users are asked again);
  - each member tenant's acceptance of a multitenant organization.
