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
    { key: 'mailboxes', name: 'Mailboxes', types: ['exchange-mailbox-settings'], match: /mailbox(settings|permission|folder|plan)?$|mailboxsettings|mailboxretention|mailuser|mailcontact|recipient|inboxrule|forwarding|autoreply|calendar/ },
    { key: 'groups', name: 'Groups and address lists', types: [], match: /distribution|dynamicgroup|unifiedgroup|roomlist|addresslist|addressbook/ },
    { key: 'roles', name: 'Admin roles', types: ['exchangeRoleDefinition', 'exchangeRoleAssignment', 'exchangeCustomAppScope'], match: /role|scope/ },
    { key: 'mail-flow', name: 'Mail flow and protection', types: ['exchange-mail-flow'], match: /mailflow|transport|connector|connectionfilter|defenderforoffice|journal|accepteddomain|remotedomain|dkim|dmarc|spam|phish|malware|safelink|safeattachment|quarantine|protection|threat/ },
    { key: 'access', name: 'Sharing and client access', types: [], match: /sharing|organizationrelationship|federation|owa|outlook|clientaccess|authpolicy|authenticationpolicy|addin/ },
    { key: 'tenant', name: 'Filtering, retention and mobile', types: ['exchange-extended'], match: /extended|filter|hygiene|retention|mobile|activesync|deviceaccess/ },
    { key: 'organization', name: 'Organization settings', types: [], match: /organization|orgconfig|setting|config/ },
  ]),
  entries: Object.freeze({
    // Exchange admin roles, read from Microsoft Graph (catalogue types take their tier's priority).
    exchangeRoleDefinition: { name: 'Exchange admin role' },
    exchangeRoleAssignment: { name: 'Exchange admin role assignment' },
    exchangeCustomAppScope: { name: 'Exchange app access scope' },
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
