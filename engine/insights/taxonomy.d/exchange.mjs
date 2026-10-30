// Exchange workload reads. Workloads have no catalogue tier, so each sets its priority.
export default Object.freeze({
  service: 'Exchange',
  prefix: /^exchange/,
  fallback: 'organization',
  // Types by kind, in the order a list shows them: people and objects first, then
  // roles and access, then policies, then tenant-wide settings. taxonomy.test.mjs fails
  // on an entry that is in no group, so a new type has to be placed here. Every group
  // the service has is listed, even with no type yet: `match` places a kind Keel has
  // not mapped yet (see placeUnmapped in ../taxonomy.mjs).
  categories: Object.freeze([
    { key: 'mailboxes', name: 'Mailboxes', types: ['exchange-recipients', 'exchange-mailbox-settings'], match: /mailbox(settings|permission|folder|plan)?$|mailboxsettings|mailboxretention|mailuser|mailcontact|recipient|inboxrule|forwarding|autoreply|calendar/ },
    { key: 'groups', name: 'Groups and address lists', types: ['exchange-distribution-groups'], match: /distribution|dynamicgroup|unifiedgroup|roomlist|addresslist|addressbook/ },
    { key: 'roles', name: 'Admin roles', types: ['exchange-role-groups', 'exchangeRoleDefinition', 'exchangeRoleAssignment', 'exchangeCustomAppScope'], match: /role|scope/ },
    { key: 'mail-flow', name: 'Mail flow and protection', types: ['exchange-mail-flow'], match: /mailflow|transport|connector|connectionfilter|defenderforoffice|journal|accepteddomain|remotedomain|dkim|dmarc|spam|phish|malware|safelink|safeattachment|quarantine|protection|threat/ },
    { key: 'access', name: 'Sharing and client access', types: ['exchange-org-access'], match: /sharing|organizationrelationship|federation|owa|outlook|clientaccess|authpolicy|authenticationpolicy|addin/ },
    { key: 'tenant', name: 'Filtering, retention and mobile', types: ['exchange-extended'], match: /extended|filter|hygiene|retention|mobile|activesync|deviceaccess/ },
    { key: 'organization', name: 'Organization settings', types: ['exchange-org-defaults'], match: /organization|orgconfig|setting|config/ },
  ]),
  entries: Object.freeze({
    // Exchange admin roles, read from Microsoft Graph (catalogue types take their tier's priority).
    exchangeRoleDefinition: { name: 'Exchange admin role' },
    exchangeRoleAssignment: { name: 'Exchange admin role assignment' },
    exchangeCustomAppScope: { name: 'Exchange app access scope' },
    // Read with Get-RoleGroup (a workload, so it sets its own priority).
    'exchange-role-groups': {
      name: 'Exchange admin role group',
      priority: 'high',
      reason: 'Its members get Exchange admin rights over the whole organization.',
    },
    // Read with Get-Mailbox, Get-MailContact and the permission cmdlets (workloads).
    'exchange-recipients': {
      name: 'Shared mailbox, room, contact or mailbox access',
      priority: 'high',
      reason: 'Decides who can open a shared mailbox, send as it or book a room.',
    },
    'exchange-distribution-groups': {
      name: 'Distribution list or Microsoft 365 group mail setting',
      priority: 'normal',
      reason: 'Decides who gets a list\'s mail and who may send to it.',
    },
    // Read with the Exchange organisation policy cmdlets (exchangeOrgPolicies.mjs).
    'exchange-org-access': {
      name: 'Exchange sharing or client access policy',
      priority: 'high',
      reason: 'Decides who outside the organization sees calendars, which apps may open mailboxes and whether legacy sign-in is allowed.',
    },
    'exchange-org-defaults': {
      name: 'Exchange transport setting or new mailbox default',
      priority: 'high',
      reason: 'Can turn SMTP AUTH back on for the whole organization or change what every new mailbox gets.',
    },
    'exchange-mailbox-settings': {
      name: 'Exchange mailbox setting',
      priority: 'high',
      reason: 'Can give someone else access to a mailbox or forward its mail.',
    },
    'exchange-mail-flow': {
      name: 'Exchange mail flow or protection rule',
      priority: 'high',
      reason: 'Can reroute, copy or let through mail for the whole organization.',
    },
    'exchange-extended': {
      name: 'Exchange filtering, retention or mobile setting',
      priority: 'normal',
      reason: 'Changes mail filtering, retention tags or mobile access for the mail it applies to.',
    },
  }),
});
