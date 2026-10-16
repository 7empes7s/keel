// Exchange workload reads. Workloads have no catalogue tier, so each sets its priority.
export default Object.freeze({
  service: 'Exchange',
  entries: Object.freeze({
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
