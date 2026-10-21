// Exchange workload reads. Workloads have no catalogue tier, so each sets its priority.
export default Object.freeze({
  service: 'Exchange',
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
